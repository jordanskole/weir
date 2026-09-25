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

// A node whose Fn reads the invocation's `step` back out — the shape
// needed to prove replay reproduces a recorded `step` rather than
// silently reverting to `invokeWithInput`'s default of 0. Reuses `Person`
// purely as a scalar carrier (`age` stands in for `step`); nothing about
// its meaning matters here.
const stepReader: NodeDecl<{ kind: "single"; edge: typeof Person }, { kind: "single"; edge: typeof Person }> = {
  name: "stepReader",
  description: "Returns the invocation's step, to prove replay reproduces it",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: Person },
};

// An edge whose one field is a string, so a node can echo back
// `env.causationIds` (a `string[]`, joined) — `Person`'s `age` is a
// uint8 and can't carry that.
const CausationEcho: AnyEdgeDef = {
  name: "CausationEcho",
  label: "CausationEcho",
  description: "Echoes back the invocation's causationIds, joined",
  fields: { value: { type: "utf8", label: "Value", description: "d", nullable: false } },
};

// A node whose Fn reads the invocation's `causationIds` back out — the
// shape needed to prove replay reproduces recorded causation rather than
// silently reverting to `invokeWithInput`'s default of `[]`.
const causationReader: NodeDecl<{ kind: "single"; edge: typeof Person }, { kind: "single"; edge: typeof CausationEcho }> = {
  name: "causationReader",
  description: "Returns the invocation's causationIds, to prove replay reproduces them",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: CausationEcho },
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
  const { result, envelope } = await invokeWithInput(nodeDef, input, { correlationId });
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

  it("replays a rejected input deterministically — the entry a rejection now produces re-rejects the same way", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-reject-"));
    const { short, hash } = await hashNode(birthday);
    await writeImpl(
      dir,
      "birthday",
      short,
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
    );

    // A malformed payload: assertPayload rejects it before Fn ever runs, but
    // membrane() now builds the envelope first (2026-09-24), so this is
    // still a real, recordable entry rather than something with no
    // provenance for `recordInvocation`'s `!envelope` guard to trip on.
    const entry = await recordInvocation(birthday, dir, hash, { age: "not-a-number" }, "c-reject");
    expect(entry.result).toEqual({
      input: { age: "not-a-number" },
      reason: expect.stringMatching(/age/),
    });

    const replayed = await replayInvocation(entry, birthday, dir);

    // Re-running rejects the same way, deterministically — the honest
    // outcome for an entry that was never a completed Fn run.
    expect(replayed).toEqual({
      input: { age: "not-a-number" },
      reason: expect.stringMatching(/age/),
    });
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

  it("rejects a scope-only widening — the drift the recorded identity could never satisfy", async () => {
    // A widened scope names a field the original invocation never recorded
    // (membrane only keeps what the declared scope narrowed to), so no
    // faithful replay exists. Since `scope` is fingerprinted, this refuses
    // by hash rather than quietly handing Fn an identity missing the field.
    dir = await mkdtemp(join(tmpdir(), "weir-replay-scope-drift-"));
    const { short, hash } = await hashNode(whoAmI);
    await writeImpl(
      dir,
      "whoAmI",
      short,
      `export default function whoAmI(payload, env) { return { value: env.identity.sub }; }\n`,
    );

    const nodeDef = await resolveImplementationAt(whoAmI, dir, hash);
    const { result, envelope } = await membrane(nodeDef, { age: 41 }, {
      correlationId: "c-scope-drift",
      identity: { sub: "alice", iss: "issuer" },
    });
    if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
    expect(envelope.identity).toEqual({ sub: "alice" });

    const widened = { ...whoAmI, scope: ["read:Identity:sub", "read:Identity:iss"] };
    const { hash: widenedHash } = await hashNode(widened);
    expect(widenedHash).not.toBe(hash);

    const entry: TraceEntry = { envelope, input: { age: 41 }, result };
    await expect(replayInvocation(entry, widened, dir)).rejects.toThrow(
      new RegExp(`Cannot replay "whoAmI"`),
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
    // membrane() already accepts identity on its context argument.
    const { result, envelope } = await membrane(nodeDef, { age: 41 }, {
      correlationId: "c-identity",
      identity: { sub: "alice", iss: "issuer" },
    });
    if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
    expect(result).toEqual({ value: "alice" });
    expect(envelope.identity).toEqual({ sub: "alice" });

    const entry: TraceEntry = { envelope, input: { age: 41 }, result };
    const replayed = await replayInvocation(entry, whoAmI, dir);

    // The recorded value ("alice"), not SYSTEM_IDENTITY's "system".
    expect(replayed).toEqual({ value: "alice" });
  });

  it("replays under the recorded step, not invokeWithInput's default of 0 (spec §6: step is identical on replay)", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-step-"));
    const { short, hash } = await hashNode(stepReader);
    await writeImpl(
      dir,
      "stepReader",
      short,
      `export default function stepReader(payload, env) { return { age: env.step }; }\n`,
    );

    const nodeDef = await resolveImplementationAt(stepReader, dir, hash);
    // Recorded at a non-zero step, as a real pulse-loop invocation would be
    // (runtime.ts's tryFire calls membrane() with the current pulse number).
    const { result, envelope } = await membrane(nodeDef, { age: 41 }, { correlationId: "c-step", step: 5 });
    if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
    expect(result).toEqual({ age: 5 });
    expect(envelope.step).toBe(5);

    const entry: TraceEntry = { envelope, input: { age: 41 }, result };
    const replayed = await replayInvocation(entry, stepReader, dir);

    // The recorded step (5), not the default 0 — if replayInvocation ever
    // stops threading entry.envelope.step through invokeWithInput, this
    // reads back { age: 0 } instead and the test reddens.
    expect(replayed).toEqual({ age: 5 });
  });

  it("replays under the recorded causationIds, not invokeWithInput's default of [] — recorded at a non-empty value deliberately, since a test recording [] would pass against the exact bug it is meant to catch", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-replay-causation-"));
    const { short, hash } = await hashNode(causationReader);
    await writeImpl(
      dir,
      "causationReader",
      short,
      `export default function causationReader(payload, env) { return { value: env.causationIds.join(",") }; }\n`,
    );

    const nodeDef = await resolveImplementationAt(causationReader, dir, hash);
    const { result, envelope } = await membrane(nodeDef, { age: 41 }, {
      correlationId: "c-causation",
      causationIds: ["inst-upstream"],
    });
    if (!envelope) throw new Error("test setup: expected an envelope from a successful invocation");
    expect(result).toEqual({ value: "inst-upstream" });
    expect(envelope.causationIds).toEqual(["inst-upstream"]);

    const entry: TraceEntry = { envelope, input: { age: 41 }, result };
    const replayed = await replayInvocation(entry, causationReader, dir);

    // The recorded causationIds (["inst-upstream"]), not the default [] —
    // if replayInvocation ever stops threading entry.envelope.causationIds
    // through invokeWithInput, this reads back { value: "" } instead and
    // the test reddens.
    expect(replayed).toEqual({ value: "inst-upstream" });
  });
});
