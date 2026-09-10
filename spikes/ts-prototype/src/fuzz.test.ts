import { describe, expect, it } from "vitest";
import { defineEdge, defineField } from "./define.js";
import { isAcceptableResult, resultMatchesOutput } from "./fuzz.js";
import type { OutputSpec } from "./types.js";

/**
 * Built with defineEdge/defineField, not a raw `: AnyEdgeDef`-annotated
 * literal — this is what lets Task 4's defineNode(single(Person))/
 * defineNode(allOf(Person, Todo)) infer each node's Fn `payload` parameter
 * as a real, narrow object type (`{ age: number }`, not `unknown`), the
 * same inference trick membrane.test.ts's own fixtures already rely on. A
 * `: AnyEdgeDef` annotation here would erase that before it ever reaches
 * defineNode.
 */
const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }),
  },
});

const Pass = defineEdge({ name: "Pass", label: "Pass", description: "A passing result", fields: {} });
const Fail = defineEdge({ name: "Fail", label: "Fail", description: "A failing result", fields: {} });

const Todo = defineEdge({
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: defineField({ type: "utf8", label: "ID", description: "d", nullable: false }),
  },
});

describe("resultMatchesOutput", () => {
  it("accepts a valid single-output payload, rejects an invalid one", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(resultMatchesOutput(output, { age: 41 })).toBe(true);
    expect(resultMatchesOutput(output, { age: "not a number" })).toBe(false);
  });

  it("accepts a correctly-tagged oneOf branch, rejects an unlisted edge name", () => {
    const output: OutputSpec = { kind: "oneOf", edges: [Pass, Fail] };
    expect(resultMatchesOutput(output, { edge: "Pass", payload: {} })).toBe(true);
    expect(resultMatchesOutput(output, { edge: "Nope", payload: {} })).toBe(false);
  });

  it("accepts every declared edge tagged for allOf, rejects a missing branch", () => {
    const output: OutputSpec = { kind: "allOf", edges: [Pass, Fail] };
    expect(
      resultMatchesOutput(output, [
        { edge: "Pass", payload: {} },
        { edge: "Fail", payload: {} },
      ]),
    ).toBe(true);
    expect(resultMatchesOutput(output, [{ edge: "Pass", payload: {} }])).toBe(false);
  });

  it("accepts a many output keyed correctly by the edge's index, rejects a mis-keyed entry", () => {
    const output: OutputSpec = { kind: "many", edge: Todo };
    expect(resultMatchesOutput(output, { "t1": { id: "t1" } })).toBe(true);
    expect(resultMatchesOutput(output, { "wrong-key": { id: "t1" } })).toBe(false);
  });
});

describe("isAcceptableResult", () => {
  it("accepts a Failed<In>-shaped result regardless of the declared output kind", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(isAcceptableResult(output, { input: { age: 41 } })).toBe(true);
    expect(isAcceptableResult(output, { input: { age: 41 }, reason: "boom" })).toBe(true);
  });

  it("rejects a result matching neither the output shape nor Failed<In>", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(isAcceptableResult(output, { garbage: true })).toBe(false);
  });
});
