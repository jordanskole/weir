import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineField, defineNode, single } from "./define.js";
import { invokeWithInput } from "./invoke.js";

const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: { age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }) },
});

const Pet = defineEdge({
  name: "Pet",
  label: "Pet",
  description: "A pet",
  fields: { species: defineField({ type: "utf8", label: "Species", description: "d", nullable: false }) },
});

const A = defineEdge({
  name: "A",
  label: "A",
  description: "Edge A",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
});

const B = defineEdge({
  name: "B",
  label: "B",
  description: "Edge B",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
});

const joinNode = defineNode({
  name: "join",
  input: allOf(A, B),
  output: single(A),
  fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
});

describe("invokeWithInput", () => {
  it("invokes a single-input node with the payload directly", async () => {
    const birthday = defineNode({
      name: "birthday",
      input: single(Person),
      output: single(Person),
      fn: (payload) => ({ age: payload.age + 1 }),
    });

    const { result } = await invokeWithInput(birthday, { age: 41 }, { correlationId: "c-1" });
    expect(result).toEqual({ age: 42 });
  });

  it("invokes an allOf-input node by appending each edge's bag entry to a fresh log", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    const { result } = await invokeWithInput(combine, { Person: { age: 41 }, Pet: { species: "cat" } }, {
      correlationId: "c-2",
    });
    expect(result).toEqual({ age: 7 });
  });

  it("resolves an allOf-input node's incomplete bag to Failed<In> — no readiness check left to wait on (Task 4)", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    const { result } = await invokeWithInput(combine, { Person: { age: 41 } }, { correlationId: "c-3" });
    expect(result).toEqual({
      input: { Person: { age: 41 } },
      reason: expect.stringMatching(/Pet/),
    });
  });

  it("returns Failed<In> rather than throwing when Fn throws — the membrane boundary, not a bypass", async () => {
    const boom = defineNode({
      name: "boom",
      input: single(Person),
      output: single(Person),
      fn: () => {
        throw new Error("nope");
      },
    });

    const { result } = await invokeWithInput(boom, { age: 41 }, { correlationId: "c-4" });
    expect(result).toEqual({ input: { age: 41 }, reason: "nope" });
  });

  it("resolves a null/undefined allOf input to Failed<In> rather than throwing a raw TypeError", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    // A malformed `given` (an author writing `given:` with nothing after it in
    // YAML parses as null) is not a real bag — every declared edge is missing,
    // so this should land exactly where a bag genuinely missing an edge does:
    // `Failed<In>`, folded into `result` here rather than escaping as a raw
    // `TypeError` trying to index into `null`/`undefined`.
    const nullResult = await invokeWithInput(combine, null, { correlationId: "c-5" });
    expect(nullResult.result).toMatchObject({ reason: expect.any(String) });
    const undefinedResult = await invokeWithInput(combine, undefined, { correlationId: "c-6" });
    expect(undefinedResult.result).toMatchObject({ reason: expect.any(String) });
  });

  it("yields Failed<In> for an incomplete bag rather than a readiness signal", async () => {
    // invokeWithInput used to stage a partial bag and let membrane return a
    // bare `undefined` meaning "not ready". A direct caller has nowhere to
    // come back from, so an incomplete bag is an error, and Failed<In> says
    // so. This is the accepted behaviour change in the spec's §5.
    const result = await invokeWithInput(joinNode, { A: { value: "a" } }, { correlationId: "c1" });

    expect(result.result).toMatchObject({ reason: expect.any(String) });
  });
});
