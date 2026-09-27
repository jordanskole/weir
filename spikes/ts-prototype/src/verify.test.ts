import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashNode } from "./hash.js";
import { resolveImplementationAt } from "./implementation.js";
import { invokeWithInput } from "./invoke.js";
import { sameResult, verifyRun } from "./verify.js";
import type { TraceEntry } from "./trace.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const Reading: AnyEdgeDef = {
  name: "Reading",
  label: "Reading",
  description: "d",
  fields: {
    value: { type: "utf8", label: "V", description: "d", nullable: false },
  },
};

const node = (name: string): NodeDecl => ({
  name,
  label: name,
  description: "d",
  input: { kind: "single", edge: Reading },
  output: { kind: "single", edge: Reading },
});

/** Writes an implementation at its contract hash and records one real invocation of it. */
async function record(decl: NodeDecl, fn: string, input: unknown): Promise<{ implRoot: string; entry: TraceEntry }> {
  dir ??= await mkdtemp(join(tmpdir(), "weir-verify-"));
  const { short, hash } = await hashNode(decl);
  await mkdir(join(dir, decl.name), { recursive: true });
  await writeFile(join(dir, decl.name, `${short}.ts`), `${fn}\n`, "utf8");
  const nodeDef = await resolveImplementationAt(decl, dir, hash);
  const { result, envelope } = await invokeWithInput(nodeDef, input, { correlationId: "c1" });
  if (!envelope) throw new Error("test setup: expected an envelope");
  return { implRoot: dir, entry: { envelope, input, result } };
}

describe("sameResult", () => {
  it("compares structurally, ignoring key order but not array order", () => {
    expect(sameResult({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(sameResult({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameResult([1, 2], [2, 1])).toBe(false);
    expect(sameResult(null, undefined)).toBe(false);
  });
});

describe("verifyRun", () => {
  it("passes a deterministic node — including one whose output expresses uncertainty", async () => {
    // A fixed-weight classifier is a deterministic function whose output
    // happens to express doubt. "Probabilistic" is not "nondeterministic",
    // and the check must not confuse them.
    const decl = node("classify");
    const { implRoot, entry } = await record(
      decl,
      `export default function classify(r) { return { value: r.value + ":cat@0.72" }; }`,
      { value: "img" },
    );

    const report = await verifyRun([entry], { classify: decl }, implRoot);

    expect(report.checked).toBe(1);
    expect(report.mismatches).toEqual([]);
  });

  it("fails a node that reads a clock, naming it and both results", async () => {
    // The test the feature exists for.
    const decl = node("stamp");
    const { implRoot, entry } = await record(
      decl,
      `export default function stamp(r) { return { value: r.value + ":" + process.hrtime.bigint().toString() }; }`,
      { value: "x" },
    );

    const report = await verifyRun([entry], { stamp: decl }, implRoot);

    expect(report.checked).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.node).toBe("stamp");
    expect(report.mismatches[0]!.recorded).not.toEqual(report.mismatches[0]!.replayed);
    expect(report.mismatches[0]!.input).toEqual({ value: "x" });
  });

  it("passes a node whose nondeterminism arrived as recorded input", async () => {
    // The row that makes a mismatch *mean* something. An effect performed by
    // the runtime and recorded arrives as ordinary input data, so the replay
    // sees the same input and returns the same output — the node touches the
    // world and still verifies, which is exactly the intended design.
    const decl = node("useSampled");
    const { implRoot, entry } = await record(
      decl,
      `export default function useSampled(r) { return { value: "chose:" + r.value }; }`,
      { value: "0.8131" },
    );

    const report = await verifyRun([entry], { useSampled: decl }, implRoot);

    expect(report.checked).toBe(1);
    expect(report.mismatches).toEqual([]);
  });

  it("skips rather than passes an entry it cannot replay", async () => {
    // A check that quietly examines nothing and reports success is the
    // failure mode this repo keeps finding. `checked` is the guard.
    const decl = node("gone");
    const { implRoot, entry } = await record(
      decl,
      `export default function gone(r) { return r; }`,
      { value: "x" },
    );

    const report = await verifyRun([entry], {}, implRoot);

    expect(report.checked).toBe(0);
    expect(report.mismatches).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toContain("not declared");
  });
});
