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

  it("resolves an allOf-input node's result to undefined when the bag is missing a declared edge — membrane's own readiness check, folded into result", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    expect(await invokeWithInput(combine, { Person: { age: 41 } }, { correlationId: "c-3" })).toEqual({
      result: undefined,
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

  it("resolves a null/undefined allOf input the same way membrane's own not-ready path does, rather than throwing a raw TypeError", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    // A malformed `given` (an author writing `given:` with nothing after it in
    // YAML parses as null) is not a real bag — every declared edge is missing,
    // so this should land exactly where a bag genuinely missing an edge does:
    // membrane's own readiness `undefined`, folded into `result` here rather
    // than escaping as a bare `undefined`.
    expect(await invokeWithInput(combine, null, { correlationId: "c-5" })).toEqual({ result: undefined });
    expect(await invokeWithInput(combine, undefined, { correlationId: "c-6" })).toEqual({ result: undefined });
  });
});
