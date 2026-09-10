import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineField, defineNode, single } from "./define.js";
import { fuzzNode, isAcceptableResult, resultMatchesOutput } from "./fuzz.js";
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

describe("fuzzNode", () => {
  it("reports passed === total for a correct single-input Fn", async () => {
    const birthday = defineNode({
      name: "birthday",
      input: single(Person),
      output: single(Person),
      fn: (payload) => ({ age: payload.age }),
    });
    const report = await fuzzNode(birthday, { count: 20 });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20);
    expect(report.failures).toEqual([]);
  });

  it("records a failure when Fn returns a result matching neither the output nor Failed<In>", async () => {
    const broken = defineNode({
      name: "broken",
      input: single(Person),
      output: single(Person),
      fn: () => ({ garbage: true }) as unknown as { age: number },
    });
    const report = await fuzzNode(broken, { count: 5 });
    expect(report.passed).toBe(0);
    expect(report.failures).toHaveLength(5);
    expect(report.failures[0]).toHaveProperty("input");
    expect(typeof report.failures[0].error).toBe("string");
  });

  it("does not count a deliberate Failed<In> return, or a thrown Fn, as a failure", async () => {
    const sometimesFails = defineNode({
      name: "sometimesFails",
      input: single(Person),
      output: single(Person),
      fn: (payload) => {
        if (payload.age % 2 === 0) throw new Error("even ages are unlucky");
        return { input: payload, reason: "manual rejection" };
      },
    });
    const report = await fuzzNode(sometimesFails, { count: 20 });
    expect(report.passed).toBe(20);
    expect(report.failures).toEqual([]);
  });

  it("fuzzes an allOf-input node correctly via the InMemoryLog path", async () => {
    const Pet = defineEdge({
      name: "Pet",
      label: "Pet",
      description: "A second, unrelated edge for a real allOf combination",
      fields: {
        species: defineField({ type: "utf8", label: "Species", description: "d", nullable: false }),
      },
    });
    // fn ignores its payload on purpose: with Person and Pet's field shapes
    // genuinely different, InputPayload's allOf mapping (types.ts) can't
    // give TS a literal-keyed `.Person`/`.Pet` split when neither edge's
    // own `name` is a literal type (EdgeDef.name is plain `string`) — this
    // test's job is checking fuzzNode's InMemoryLog/allOf wiring, not Fn's
    // own bag-reading, which membrane.test.ts's "allOf" suite already
    // covers directly.
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 1 }),
    });
    const report = await fuzzNode(combine, { count: 10 });
    expect(report.total).toBe(10);
    expect(report.passed).toBe(10);
    expect(report.failures).toEqual([]);
  });

  it("defaults to count: 100 when opts are omitted", async () => {
    const alwaysPasses = defineNode({
      name: "alwaysPasses",
      input: single(Person),
      output: single(Person),
      fn: (payload) => payload,
    });
    const report = await fuzzNode(alwaysPasses);
    expect(report.total).toBe(100);
  });
});
