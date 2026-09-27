import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTrace } from "./file-trace.js";
import { InMemoryTrace } from "./trace.js";
import type { Trace, TraceEntry } from "./trace.js";
import type { Envelope } from "./types.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function tracePath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-trace-"));
  return join(dir, "weir-trace.jsonl");
}

const entry = (id: string, correlationId: string, result: unknown): TraceEntry => ({
  envelope: {
    id,
    correlationId,
    node: "birthday",
    contractHash: "abc",
    timestamp: "2026-09-26T00:00:00.000Z",
    step: 1,
    identity: {},
    causationIds: [],
  } as Envelope,
  input: { age: 41 },
  result,
});

/** One suite, both implementations — so the durable one cannot quietly diverge. */
function behavesLikeATrace(name: string, make: () => Promise<Trace>): void {
  describe(name, () => {
    it("returns a correlation's entries in record order, and only that correlation's", async () => {
      const trace = await make();
      trace.record(entry("e1", "c1", { age: 42 }));
      trace.record(entry("e2", "c2", { age: 1 }));
      trace.record(entry("e3", "c1", { age: 43 }));

      expect(trace.entries("c1").map((e) => e.envelope.id)).toEqual(["e1", "e3"]);
      expect(trace.entries("c2").map((e) => e.envelope.id)).toEqual(["e2"]);
      expect(trace.entries("nope")).toEqual([]);
    });

    it("returns a copy, so a caller can iterate while a run records", async () => {
      const trace = await make();
      trace.record(entry("e1", "c1", { age: 42 }));
      const first = trace.entries("c1");
      trace.record(entry("e2", "c1", { age: 43 }));

      expect(first).toHaveLength(1);
    });
  });
}

behavesLikeATrace("InMemoryTrace", async () => new InMemoryTrace());
behavesLikeATrace("FileTrace", async () => FileTrace.open(await tracePath()));

describe("FileTrace — durability", () => {
  it("reloads every entry with its envelope, input and result intact", async () => {
    const path = await tracePath();
    const written = FileTrace.open(path);
    written.record(entry("e1", "c1", { age: 42 }));
    written.record(entry("e2", "c1", { age: 43 }));

    const reloaded = FileTrace.open(path);

    expect(reloaded.entries("c1")).toEqual(written.entries("c1"));
    // The result is what the determinism check compares against, so it
    // surviving the round trip is the point rather than a detail.
    expect(reloaded.entries("c1")[1]!.result).toEqual({ age: 43 });
  });

  it("appends across sessions rather than truncating", async () => {
    const path = await tracePath();
    FileTrace.open(path).record(entry("e1", "c1", { age: 42 }));
    FileTrace.open(path).record(entry("e2", "c1", { age: 43 }));

    expect(FileTrace.open(path).entries("c1").map((e) => e.envelope.id)).toEqual(["e1", "e2"]);
  });
});
