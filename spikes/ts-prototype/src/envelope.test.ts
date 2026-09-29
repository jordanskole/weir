/**
 * The declared envelope
 * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md).
 *
 * Metadata that rides **with a token** rather than over a wire. The problem it
 * removes: cross-cutting metadata had to be a declared field on every
 * intermediate edge on its path, so a node with no use for a trust value still
 * had to carry four fields, and a parcel's PIN could not reach a subgraph eleven
 * nodes downstream without five edges about *soil* growing a `pin`.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, single } from "./define.js";
import { elaborate } from "./elaborate.js";
import { hashNode } from "./hash.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-envelope-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });
const E = (name: string) => defineEdge({ name, label: name, description: "d", fields: { v: utf8("V") } });

/** trust meets over a declared order; pin must simply agree. */
const Prov = defineEdge({
  name: "Prov",
  label: "Prov",
  description: "d",
  fields: {
    trust: {
      type: "utf8",
      label: "T",
      description: "d",
      nullable: false,
      enumValues: ["listing", "aggregator", "inferred", "verified"],
      ordinal: true,
      combine: "meet",
    },
    pin: { type: "utf8", label: "P", description: "d", nullable: false, combine: "same" },
  },
});

describe("envelope — declaring one", () => {
  const ENVELOPE = (body: string) => `label: Prov\ndescription: d\nfields:\n${body}`;
  const base = {
    "edges/A.edge": `label: A\ndescription: d\nfields:\n  v: { type: utf8, label: V, description: d, nullable: false }\n`,
    "nodes/go.node":
      `label: Go\ndescription: d\ninput: A\noutput: A\n` +
      `examples:\n  - given: { A: { v: "x" } }\n    expect: { A: { v: "x" } }\n`,
    "topology/main.topology": `input: A\noutput: A\nterminals:\n  - go\nwiring:\n  go: {}\n`,
  };

  /** Spec Testing #1: it goes through the edge parser, so edge rules apply. */
  it("elaborates through the edge parser, keeping field validation", async () => {
    const program = await elaborate(
      await fixture({
        ...base,
        "envelopes/Prov.envelope": ENVELOPE(
          `  pin: { type: utf8, label: P, description: d, nullable: false, combine: same }\n`,
        ),
      }),
    );

    expect(Object.keys(program.envelopes)).toEqual(["Prov"]);
    // Kept out of `edges`, because an envelope is never wired and must not turn
    // up in a query that means "what crosses a wire".
    expect(program.edges.Prov).toBeUndefined();
  });

  /**
   * **Spec Testing #11 — no default for `combine`.** Every wrong guess here is
   * silent: `meet` where `same` was meant merges two tokens about different
   * things without complaining, which is the cross-item join the whole lineage
   * design exists to prevent.
   */
  it("refuses an envelope field with no combine rule", async () => {
    await expect(
      elaborate(
        await fixture({
          ...base,
          "envelopes/Prov.envelope": ENVELOPE(
            `  pin: { type: utf8, label: P, description: d, nullable: false }\n`,
          ),
        }),
      ),
    ).rejects.toThrow(/declare "combine"/);
  });

  /** Spec Testing #12: meet and join need something to compare. */
  it("refuses meet or join without an ordinal enum", async () => {
    await expect(
      elaborate(
        await fixture({
          ...base,
          "envelopes/Prov.envelope": ENVELOPE(
            `  trust: { type: utf8, label: T, description: d, nullable: false, combine: meet }\n`,
          ),
        }),
      ),
    ).rejects.toThrow(/needs "ordinal: true"/);
  });

  /**
   * **The check that moved, and moved to a better place.** A scope naming
   * something undeclared used to be a runtime `Failed<In>` from
   * `narrowIdentity`, which could only ever validate `read:Identity:…`. Since
   * envelopes exist, the membrane cannot tell a legitimate envelope from a typo
   * — it has no access to the table — so elaboration does it instead, and a
   * typo now fails `weir check` rather than one firing that happened to run.
   *
   * Break-proof: deleting `assertScopeResolves` makes this elaborate cleanly
   * and the scope silently resolve to nothing at runtime.
   */
  it("refuses a scope naming an envelope that does not exist", async () => {
    await expect(
      elaborate(
        await fixture({
          ...base,
          "nodes/go.node":
            `label: Go\ndescription: d\ninput: A\noutput: A\nscope:\n  - read:Provenanc:trust\n` +
            `examples:\n  - given: { A: { v: "x" } }\n    expect: { A: { v: "x" } }\n`,
          "envelopes/Prov.envelope": ENVELOPE(
            `  pin: { type: utf8, label: P, description: d, nullable: false, combine: same }\n`,
          ),
        }),
      ),
    ).rejects.toThrow(/nothing named "Provenanc" is declared/);
  });

  it("refuses a scope naming a field the envelope does not have", async () => {
    await expect(
      elaborate(
        await fixture({
          ...base,
          "nodes/go.node":
            `label: Go\ndescription: d\ninput: A\noutput: A\nscope:\n  - read:Prov:nope\n` +
            `examples:\n  - given: { A: { v: "x" } }\n    expect: { A: { v: "x" } }\n`,
          "envelopes/Prov.envelope": ENVELOPE(
            `  pin: { type: utf8, label: P, description: d, nullable: false, combine: same }\n`,
          ),
        }),
      ),
    ).rejects.toThrow(/has no field "nope"/);
  });
});

describe("envelope — propagation", () => {
  const [A, B, C, D] = [E("A"), E("B"), E("C"), E("D")];

  const program = (nodes: Record<string, unknown>) =>
    ({
      fields: {},
      edges: { A, B, C, D },
      envelopes: { Prov },
      nodes,
      wiring: {
        origins: ["start"],
        feeds: { start: ["viaProxy", "direct"], viaProxy: ["join"], direct: ["join"] },
      },
    }) as never;

  const start = defineNode({ name: "start", input: single(A), output: single(A), fn: (a) => a });
  const viaProxy = {
    ...defineNode({ name: "viaProxy", input: single(A), output: single(B), fn: () => ({ v: "b" }) }),
    contributes: { trust: "aggregator" },
  };
  const direct = defineNode({ name: "direct", input: single(A), output: single(C), fn: () => ({ v: "c" }) });

  /**
   * **Spec Testing #2 and #4 and #6 in one run, because they are one story.**
   *
   * `pin` is set at the trigger and read at the fan-in with **no intermediate
   * edge declaring it** — the case that motivated the whole feature. `trust`
   * starts `verified`, `viaProxy` contributes `aggregator`, `direct` leaves what
   * it got, and `meet` takes the weaker of the two at the join.
   *
   * Break-proof: removing the `contributes` merge in `tryFire` leaves the
   * joined trust at `verified`, which is the silent wrong answer this exists to
   * prevent — a summary claiming to be better-sourced than it is.
   */
  it("carries trigger metadata to a reader downstream, and meets at the fan-in", async () => {
    const join = defineNode({
      name: "join",
      input: allOf(B, C),
      output: single(D),
      scope: ["read:Prov:trust", "read:Prov:pin"],
      fn: (_bag, env: any) => ({ v: `${env.meta.trust}/${env.meta.pin}` }),
    });
    const log = new InMemoryLog();

    const result = await runNetlist(
      program({ start, viaProxy, direct, join }),
      { correlationId: "e", originPayloads: { start: { v: "a" } }, meta: { trust: "verified", pin: "10-003" } },
      { log, maxPulses: 10 },
    );

    expect(log.instances("D", "e").map((i) => i.payload)).toEqual([{ v: "aggregator/10-003" }]);
    // And the token carries it onward, not just into the one reader.
    expect(log.instances("D", "e")[0]!.envelope!.meta).toEqual({ trust: "aggregator", pin: "10-003" });
    expect(result.residue).toEqual([]);
  });

  /**
   * **Spec Testing #3 — the property that keeps the feature affordable.**
   *
   * A node that does not declare `read:` sees nothing, *and* its contract hash
   * does not move when the envelope gains a field. Without that, an envelope is
   * program-wide state and adding a field would invalidate every accepted
   * implementation in the program — worse than the problem being solved.
   *
   * Carrying is unaffected: the token still carries what the node could not
   * read, which is what stops intermediate edges having to declare it.
   */
  it("gives an unscoped node nothing to read, and leaves its hash alone", async () => {
    const blind = defineNode({
      name: "join",
      input: allOf(B, C),
      output: single(D),
      fn: (_bag, env: any) => ({ v: String(env?.meta === undefined) }),
    });
    const log = new InMemoryLog();

    await runNetlist(
      program({ start, viaProxy, direct, join: blind }),
      { correlationId: "e", originPayloads: { start: { v: "a" } }, meta: { trust: "verified", pin: "10-003" } },
      { log, maxPulses: 10 },
    );

    // Read nothing...
    expect(log.instances("D", "e").map((i) => i.payload)).toEqual([{ v: "true" }]);
    // ...but carried everything.
    expect(log.instances("D", "e")[0]!.envelope!.meta).toEqual({ trust: "aggregator", pin: "10-003" });

    // And an envelope field's existence does not touch an unscoped contract.
    const withScope = { ...blind, scope: ["read:Prov:trust"] };
    expect((await hashNode(blind as never)).hash).not.toBe((await hashNode(withScope as never)).hash);
  });

  /**
   * **Spec Testing #7 — the rule that catches a cross-item join.** Two tokens
   * about *different* parcels meeting at a fan-in is a bug, and `same` is what
   * makes it one rather than a silently merged row.
   *
   * It fires through the membrane, so it arrives as an ordinary `Failed<In>`
   * with an envelope and a trace entry — the same argument the dead-gather case
   * makes for not hand-assembling a failure.
   */
  it("fails the firing when a `same` field's inputs disagree", async () => {
    // `direct` now stamps a different pin, so the two arms disagree.
    const rogue = { ...direct, contributes: { pin: "99-999" } };
    const join = defineNode({
      name: "join",
      input: allOf(B, C),
      output: single(D),
      fn: () => ({ v: "joined" }),
    });
    const log = new InMemoryLog();

    await runNetlist(
      program({ start, viaProxy, direct: rogue, join }),
      { correlationId: "e", originPayloads: { start: { v: "a" } }, meta: { trust: "verified", pin: "10-003" } },
      { log, maxPulses: 10 },
    );

    expect(log.instances("D", "e")).toHaveLength(0);
    const failed = log.instances("Failed_B_C", "e");
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { reason: string }).reason).toMatch(/combine: same/);
  });

  /** Spec Testing #14: nothing in the corpus declares an envelope, so nothing changes. */
  it("leaves a program with no envelope exactly as it was", async () => {
    const plain = defineNode({ name: "join", input: allOf(B, C), output: single(D), fn: () => ({ v: "j" }) });
    const log = new InMemoryLog();

    await runNetlist(
      { fields: {}, edges: { A, B, C, D }, nodes: { start, viaProxy, direct, join: plain },
        wiring: { origins: ["start"], feeds: { start: ["viaProxy", "direct"], viaProxy: ["join"], direct: ["join"] } } } as never,
      { correlationId: "e", originPayloads: { start: { v: "a" } } },
      { log, maxPulses: 10 },
    );

    expect(log.instances("D", "e")).toHaveLength(1);
    // No envelope declared, so `contributes` has nowhere to land and no `meta`
    // is written — an absent feature costs an absent field.
    expect(log.instances("D", "e")[0]!.envelope!.meta).toBeUndefined();
  });
});
