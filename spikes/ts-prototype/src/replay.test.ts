import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashNode } from "./hash.js";
import { resolveImplementationAt } from "./implementation.js";
import { invokeWithInput } from "./invoke.js";
import { membrane } from "./membrane.js";
import { replayInvocation } from "./replay.js";
import type { TraceEntry } from "./trace.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

const Person: AnyEdgeDef = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: { age: { type: "uint8", label: "Age", description: "d", nullable: false } },
};

// A structurally different Person — a second, wider edge — so a node
// declared against it hashes to a genuinely different contract, not just a
// cosmetic change.
const PersonV2: AnyEdgeDef = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: { type: "uint8", label: "Age", description: "d", nullable: false },
    nickname: { type: "utf8", label: "Nickname", description: "d", nullable: true },
  },
};

const birthday: NodeDecl = {
  name: "birthday",
  description: "Increments a person's age by one year",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: Person },
};

const birthdayV2: NodeDecl = {
  ...birthday,
  input: { kind: "single", edge: PersonV2 },
  output: { kind: "single", edge: PersonV2 },
};

// A node whose Fn reads the caller's narrowed identity back out — the
// shape needed to prove replay recovers a recorded identity rather than
// silently falling through to SYSTEM_IDENTITY. Typed with concrete
// generics (not the plain, doubly-defaulted `NodeDecl` the other fixtures
// above use) so `membrane()` resolves its real call shape directly, with
// no `AnySingleInvoke`-style cast needed in this test.
const whoAmI: NodeDecl<{ kind: "single"; edge: typeof Person }, { kind: "single"; edge: typeof Person }> = {
  name: "whoAmI",
  description: "Returns the caller's identity sub, narrowed via scope",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: Person },
  scope: ["read:Identity:sub"],
};

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function writeImpl(implRoot: string, nodeName: string, short: string, source: string): Promise<void> {
  await mkdir(join(implRoot, nodeName), { recursive: true });
  await writeFile(join(implRoot, nodeName, `${short}.ts`), source, "utf8");
}

async function recordInvocation(
  nodeDecl: NodeDecl,
  implRoot: string,
  contractHash: string,
  input: unknown,
  correlationId: string,
): Promise<TraceEntry> {
  const nodeDef = await resolveImplementationAt(nodeDecl, implRoot, contractHash);
  const { result, envelope } = await invokeWithInput(nodeDef, input, correlationId);
  if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
  return { envelope, input, result };
}

describe("replayInvocation", () => {
  it("returns the pinned implementation's result for a recorded entry", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-"));
    const { short, hash } = await hashNode(birthday);
    await writeImpl(
      dir,
      "birthday",
      short,
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
    );

    const entry = await recordInvocation(birthday, dir, hash, { age: 41 }, "c-1");
    expect(entry.result).toEqual({ age: 42 });

    const replayed = await replayInvocation(entry, birthday, dir);

    expect(replayed).toEqual({ age: 42 });
  });

  it("the pin does its job: a second implementation accepted under a new contract hash doesn't change what an old entry replays to", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-pin-"));
    const { short: shortA, hash: hashA } = await hashNode(birthday);
    const { short: shortB, hash: hashB } = await hashNode(birthdayV2);
    expect(hashA).not.toBe(hashB);

    // The original implementation, accepted under hash A: age + 1.
    await writeImpl(
      dir,
      "birthday",
      shortA,
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
    );

    // Record an invocation that ran under the original contract/implementation.
    const entry = await recordInvocation(birthday, dir, hashA, { age: 41 }, "c-2");
    expect(entry.result).toEqual({ age: 42 });
    expect(entry.envelope.contractHash).toBe(hashA);

    // Now a second, different implementation is accepted for the SAME node
    // name, under the NEW contract hash B — a very different behaviour, so
    // there's no mistaking which one ran.
    await writeImpl(
      dir,
      "birthday",
      shortB,
      `export default function birthday(payload) { return { age: payload.age + 999 }; }\n`,
    );

    // Replaying the old entry, against the unchanged original declaration,
    // must still produce the OLD behaviour — not the new implementation
    // that now also lives on disk for this node.
    const replayed = await replayInvocation(entry, birthday, dir);

    expect(replayed).toEqual({ age: 42 });
  });

  it("rejects a drifted declaration, naming both hashes", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-drift-"));
    const { short: shortA, hash: hashA } = await hashNode(birthday);
    const { hash: hashB } = await hashNode(birthdayV2);
    await writeImpl(
      dir,
      "birthday",
      shortA,
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
    );

    const entry = await recordInvocation(birthday, dir, hashA, { age: 41 }, "c-3");

    await expect(replayInvocation(entry, birthdayV2, dir)).rejects.toThrow(
      new RegExp(
        `Cannot replay "birthday".*${hashB}.*${hashA}|Cannot replay "birthday".*${hashA}.*${hashB}`,
      ),
    );
  });

  it("fails loudly when the pinned implementation has no file on disk, naming node and hash", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-missing-"));
    const { short: shortA, hash: hashA } = await hashNode(birthday);
    await writeImpl(
      dir,
      "birthday",
      shortA,
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
    );
    const entry = await recordInvocation(birthday, dir, hashA, { age: 41 }, "c-4");

    // Remove the implementation before replaying, simulating a pin whose
    // file never made it to disk (or was lost).
    await rm(join(dir, "birthday", `${shortA}.ts`));

    await expect(replayInvocation(entry, birthday, dir)).rejects.toThrow(
      new RegExp(`No accepted implementation for "birthday".*${shortA}`),
    );
  });

  it("replays under the recorded identity, not SYSTEM_IDENTITY — a node whose scope reads Identity:sub", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-identity-"));
    const { short, hash } = await hashNode(whoAmI);
    await writeImpl(
      dir,
      "whoAmI",
      short,
      `export default function whoAmI(payload, env) { return { value: env.identity.sub }; }\n`,
    );

    const nodeDef = await resolveImplementationAt(whoAmI, dir, hash);
    // Recorded under a real caller identity, not the system default —
    // membrane() already accepts this third argument.
    const { result, envelope } = await membrane(nodeDef)({ age: 41 }, "c-identity", {
      sub: "alice",
      iss: "issuer",
    });
    if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
    expect(result).toEqual({ value: "alice" });
    expect(envelope.identity).toEqual({ sub: "alice" });

    const entry: TraceEntry = { envelope, input: { age: 41 }, result };
    const replayed = await replayInvocation(entry, whoAmI, dir);

    // The recorded value ("alice"), not SYSTEM_IDENTITY's "system".
    expect(replayed).toEqual({ value: "alice" });
  });
});
