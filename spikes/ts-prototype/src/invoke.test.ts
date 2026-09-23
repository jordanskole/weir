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

    expect(await invokeWithInput(birthday, { age: 41 }, "c-1")).toEqual({ age: 42 });
  });

  it("invokes an allOf-input node by appending each edge's bag entry to a fresh log", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    expect(await invokeWithInput(combine, { Person: { age: 41 }, Pet: { species: "cat" } }, "c-2")).toEqual({ age: 7 });
  });

  it("resolves an allOf-input node to undefined when the bag is missing a declared edge — membrane's own readiness check, unchanged", async () => {
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 7 }),
    });

    expect(await invokeWithInput(combine, { Person: { age: 41 } }, "c-3")).toBeUndefined();
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

    expect(await invokeWithInput(boom, { age: 41 }, "c-4")).toEqual({ input: { age: 41 }, reason: "nope" });
  });
});
