import { describe, expect, it } from "vitest";
import { InMemoryTrace } from "./trace.js";
import type { Envelope } from "./types.js";

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "invocation-1",
    correlationId: "thread-1",
    causationId: null,
    timestamp: "2026-09-23T00:00:00.000Z",
    step: 0,
    identity: {},
    node: "someNode",
    contractHash: "hash-1",
    ...overrides,
  };
}

describe("InMemoryTrace", () => {
  it("records an entry, then returns it from entries() for its correlation id", () => {
    const trace = new InMemoryTrace();
    const entry = { envelope: envelope(), input: { value: "a" }, result: { value: "aa" } };

    trace.record(entry);

    expect(trace.entries("thread-1")).toEqual([entry]);
  });

  it("returns entries in recorded order for the same correlation id", () => {
    const trace = new InMemoryTrace();
    const first = { envelope: envelope({ id: "inv-1" }), input: { value: "a" }, result: { value: "a1" } };
    const second = { envelope: envelope({ id: "inv-2" }), input: { value: "a1" }, result: { value: "a1-2" } };

    trace.record(first);
    trace.record(second);

    expect(trace.entries("thread-1")).toEqual([first, second]);
  });

  it("does not return entries recorded under a different correlation id", () => {
    const trace = new InMemoryTrace();
    const other = { envelope: envelope({ correlationId: "thread-2" }), input: {}, result: {} };
    trace.record(other);

    expect(trace.entries("thread-1")).toEqual([]);
  });
});
