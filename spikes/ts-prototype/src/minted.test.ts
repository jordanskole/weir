/**
 * Host-minted fields — `id: { minted: uuid }`.
 *
 * A fourth field kind beside `many` / `fields` / `literal`, for a value the host
 * assigns and the implementation never supplies. The argument for a *kind* rather
 * than a scalar type, and for a declaration rather than a `scope` read, is in
 * docs/open-questions/a-minted-field-kind.md; the short version is that declaring it
 * tells replay which fields to re-feed, so declared nondeterminism stays replayable.
 *
 * The asymmetry is in who *fills* it, not in how it is validated: the `fn` returns its
 * output without the field, the membrane fills it before anything asserts, and
 * `assertPayload` then treats it as an ordinary required field on both sides.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEdge, defineField, defineNode, single } from "./define.js";
import { elaborate } from "./elaborate.js";
import { InMemoryLog, assertPayload, membrane, mintedFrom, withoutMinted } from "./membrane.js";
import { generateFieldValue, createRng } from "./generate.js";
import { hashEdge, hashNode } from "./hash.js";
import { elaborateWithImplementations } from "./implementation.js";
import { InMemoryTrace } from "./trace.js";
import { runNetlist } from "./runtime.js";
import { replayInvocation } from "./replay.js";
import { emitZodModule } from "./emit-zod.js";
import type { AnyEdgeDef, MintedFieldDef, NodeDecl } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const mintedId: MintedFieldDef = {
  minted: "uuid",
  label: "ID",
  description: "Minted by the host, never by the implementation",
};

const Thing = defineEdge({
  name: "Thing",
  label: "Thing",
  description: "A thing with a host-minted id",
  fields: {
    id: mintedId,
    name: defineField({ type: "utf8", label: "Name", description: "d", nullable: false }),
  },
});
const NewThing = defineEdge({
  name: "NewThing",
  label: "New Thing",
  description: "What a caller provides",
  fields: { name: defineField({ type: "utf8", label: "Name", description: "d", nullable: false }) },
});

/** A node whose `fn` correctly omits the minted field. */
const makeThing = defineNode({
  name: "makeThing",
  input: single(NewThing),
  output: single(Thing),
  fn: (p: any) => ({ name: p.name }),
} as any);

const ctx = { correlationId: "t" } as any;

describe("minted fields — the membrane fills them", () => {
  /** BREAK-PROOF: removing the `fillMinted` call from `callFn` reddens this. */
  it("mints a uuid the implementation did not return", async () => {
    const { result } = await membrane(makeThing as any, { name: "a widget" } as any, ctx);
    expect(result).toMatchObject({ name: "a widget" });
    expect((result as any).id).toMatch(UUID);
  });

  it("mints a different value each invocation", async () => {
    const a = await membrane(makeThing as any, { name: "x" } as any, ctx);
    const b = await membrane(makeThing as any, { name: "x" } as any, ctx);
    expect((a.result as any).id).not.toBe((b.result as any).id);
  });

  /**
   * The one asymmetric rule: never suppliable, the same property `LiteralFieldDef`
   * has. Refused rather than overwritten, because an implementation that invents an
   * identity is wrong in the way "never suppliable" means — and a silent overwrite
   * would hide it.
   *
   * BREAK-PROOF: deleting the `Object.hasOwn` guard in `fillMinted` reddens this and
   * nothing else.
   */
  it("refuses a result that supplied the minted field", async () => {
    const liar = defineNode({
      name: "liar",
      input: single(NewThing),
      output: single(Thing),
      fn: (p: any) => ({ name: p.name, id: "i-made-this-up" }),
    } as any);
    const { result } = await membrane(liar as any, { name: "x" } as any, ctx);
    expect(result).toMatchObject({ reason: expect.stringContaining("may not be returned") });
  });

  /**
   * Symmetric validation is the payoff of minting *before* asserting. If
   * `assertPayload` had to know which side it was on, one function would need two
   * rules — see the cost section of the open question.
   */
  it("requires the field present once filled, on either side", () => {
    expect(() => assertPayload(Thing as AnyEdgeDef, { name: "x", id: "anything" })).not.toThrow();
    expect(() => assertPayload(Thing as AnyEdgeDef, { name: "x" })).toThrow(/host-minted/);
    expect(() => assertPayload(Thing as AnyEdgeDef, { name: "x", id: 7 })).toThrow(/host-minted/);
  });
});

describe("minted fields — replay re-feeds them", () => {
  /**
   * The load-bearing claim, and the reason this is a declaration rather than a
   * `scope` read: weir knows which fields are nondeterministic because the author
   * said so, so replay knows mechanically which to hand back.
   *
   * BREAK-PROOF: removing `minted:` from `replay.ts`'s context reddens this. Verified
   * end to end too — `weir verify` goes from "replayed identically" to showing the two
   * differing uuids side by side.
   */
  it("reproduces a recorded value when the context supplies it", async () => {
    const first = await membrane(makeThing as any, { name: "a widget" } as any, ctx);
    const recorded = mintedFrom(makeThing.output as any, first.result);
    expect(recorded).toEqual({ "Thing.id": (first.result as any).id });

    const again = await membrane(makeThing as any, { name: "a widget" } as any, {
      ...ctx,
      minted: recorded,
    } as any);
    expect(again.result).toEqual(first.result);
  });

  it("mints fresh when the context supplies nothing, which is what a fork wants", async () => {
    const first = await membrane(makeThing as any, { name: "x" } as any, ctx);
    const forked = await membrane(makeThing as any, { name: "x" } as any, ctx);
    expect((forked.result as any).id).not.toBe((first.result as any).id);
  });

  it("strips minted fields for comparison against a declared example", async () => {
    const { result } = await membrane(makeThing as any, { name: "a widget" } as any, ctx);
    expect(withoutMinted(makeThing.output as any, result)).toEqual({ name: "a widget" });
  });
});

describe("minted fields — the declaration", () => {
  /**
   * The strategy is in the contract; the prose is not. Same rule every other field
   * follows, and it means swapping `uuid` for a future `ulid` is a contract change
   * that invalidates accepted implementations, which is correct.
   */
  it("fingerprints the strategy", async () => {
    const other = defineEdge({
      ...Thing,
      fields: { ...Thing.fields, id: { ...mintedId, description: "different prose" } },
    } as any);
    expect((await hashEdge(other as AnyEdgeDef)).hash).toBe((await hashEdge(Thing as AnyEdgeDef)).hash);

    const asPlainString = defineEdge({
      ...Thing,
      fields: {
        ...Thing.fields,
        id: defineField({ type: "utf8", label: "ID", description: "d", nullable: false }),
      },
    } as any);
    expect((await hashEdge(asPlainString as AnyEdgeDef)).hash).not.toBe(
      (await hashEdge(Thing as AnyEdgeDef)).hash,
    );
  });

  /**
   * The generator must produce it from the **seed**, never `crypto.randomUUID`, or a
   * seeded batch stops being reproducible. That it can is one of the arguments for a
   * field kind over a `pattern` on a `utf8`, which `generateStringValue` refuses.
   */
  it("is generated deterministically from the seed", () => {
    const once = generateFieldValue("id", mintedId, createRng(42), 0) as string;
    const again = generateFieldValue("id", mintedId, createRng(42), 0) as string;
    expect(once).toMatch(UUID);
    expect(again).toBe(once);
    expect(generateFieldValue("id", mintedId, createRng(43), 0)).not.toBe(once);
  });

  it("emits as a required string on the edge, and is omitted from the fn's return", () => {
    const source = emitZodModule(makeThing as unknown as NodeDecl);
    expect(source).toContain('"id": z.string().min(1)');
    expect(source).toContain('export const makeThingOutput = Thing.omit({ "id": true });');
  });
});

describe("minted fields — what elaboration refuses", () => {
  async function app(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "weir-minted-"));
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), body, "utf8");
    }
    try {
      await elaborate(root);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  }

  const THING = `label: Thing
description: d
index: id
fields:
  id:
    minted: uuid
    label: ID
    description: d
  name:
    type: utf8
    label: Name
    description: d
    nullable: false
`;
  const NEW = `label: New Thing
description: d
fields:
  name:
    type: utf8
    label: Name
    description: d
    nullable: false
`;

  it("accepts a minted field, and a minted index on an edge nothing collects", async () => {
    expect(
      await app({
        "src/edges/Thing.edge": THING,
        "src/edges/NewThing.edge": NEW,
        "src/nodes/makeThing.node": `label: Make
description: d
input: NewThing
output: Thing
examples:
  - given:
      NewThing:
        name: "a widget"
    expect:
      Thing:
        name: "a widget"
`,
      }),
    ).toBe("");
  });

  /**
   * Circular rather than stylistic: the key-agreement rule needs each entry under its
   * own index value, the implementation builds the collection, and a minted value is
   * assigned after it returns.
   *
   * BREAK-PROOF: removing the check from `requireIndex` reddens this.
   */
  it("refuses a minted field as a collection key", async () => {
    const message = await app({
      "src/edges/Thing.edge": THING,
      "src/edges/NewThing.edge": NEW,
      "src/edges/Bag.edge": `label: Bag
description: d
fields:
  things:
    many: Thing
`,
      "src/nodes/collect.node": `label: Collect
description: d
input: NewThing
output: Bag
examples:
  - given:
      NewThing:
        name: "a widget"
    expect:
      Bag:
        things: {}
`,
    });
    expect(message).toMatch(/index "id" is host-minted/);
  });

  /**
   * The same rule the implementation gets. An example naming a minted value would be
   * asserting a uuid nobody can know, which is why `accept` compares with them
   * removed.
   *
   * BREAK-PROOF: removing the `supplies` check from `assertExamplePayloads` reddens
   * this.
   */
  it("refuses an example that supplies a minted field", async () => {
    const message = await app({
      "src/edges/Thing.edge": THING,
      "src/edges/NewThing.edge": NEW,
      "src/nodes/makeThing.node": `label: Make
description: d
input: NewThing
output: Thing
examples:
  - given:
      NewThing:
        name: "a widget"
    expect:
      Thing:
        name: "a widget"
        id: "made-up-by-the-author"
`,
    });
    expect(message).toMatch(/supplies "id", which "Thing" declares as host-minted/);
  });
});

/**
 * `replayInvocation` really re-feeds, which the direct-`membrane` test above does
 * **not** prove.
 *
 * That gap was found by a break-proof: removing `minted:` from `replay.ts`'s context
 * reddened nothing, because the earlier test hands `fillMinted` the map itself and
 * never goes through replay. This goes through replay.
 */
describe("minted fields — replayInvocation re-feeds, through the real path", () => {
  const PROGRAM = {
    "src/edges/NewThing.edge": `label: New Thing
description: d
fields:
  name:
    type: utf8
    label: Name
    description: d
    nullable: false
`,
    "src/edges/Thing.edge": `label: Thing
description: d
fields:
  id:
    minted: uuid
    label: ID
    description: d
  name:
    type: utf8
    label: Name
    description: d
    nullable: false
`,
    "src/nodes/makeThing.node": `label: Make
description: d
input: NewThing
output: Thing
examples:
  - given:
      NewThing:
        name: "a widget"
    expect:
      Thing:
        name: "a widget"
`,
    "src/topology/main.topology": `input: NewThing
output: Thing
terminals:
  - makeThing
wiring:
  makeThing: {}
`,
  };

  /** BREAK-PROOF: removing `minted:` from `replay.ts`'s context reddens this. */
  it("reproduces the recorded uuid rather than minting a new one", async () => {
    const root = await mkdtemp(join(tmpdir(), "weir-minted-replay-"));
    for (const [rel, content] of Object.entries(PROGRAM)) {
      await mkdir(join(root, rel, ".."), { recursive: true });
      await writeFile(join(root, rel), content, "utf8");
    }

    const raw = await elaborate(root);
    const implRoot = join(root, "impl");
    const hash = (await hashNode(raw.nodes.makeThing!)).short;
    await mkdir(join(implRoot, "makeThing"), { recursive: true });
    await writeFile(
      join(implRoot, "makeThing", `${hash}.ts`),
      `export default function makeThing(p) { return { name: p.name }; }\n`,
      "utf8",
    );

    const program = await elaborateWithImplementations(root, implRoot);
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();
    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { makeThing: { name: "a widget" } } },
      { log, trace },
    );

    const entry = trace.entries("c1").find((e) => e.envelope.node === "makeThing")!;
    expect((entry.result as any).id).toMatch(UUID);

    const replayed = await replayInvocation(entry, program.nodes.makeThing!, implRoot);
    // The whole claim: a declared nondeterministic field replays identically, so
    // `weir verify` has nothing to flag. Verified end to end too — without the
    // re-feed, verify prints the two differing uuids side by side.
    expect(replayed).toEqual(entry.result);
  });
});
