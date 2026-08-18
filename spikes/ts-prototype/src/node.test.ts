import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineField, defineNode, many, oneOf, single } from "./define.js";
import { Unit } from "./types.js";

const Person = defineEdge({
  name: "Person",
  fields: { age: defineField({ type: "uint8" }) },
});

const Pass = defineEdge({ name: "Pass", fields: {} });
const Fail = defineEdge({ name: "Fail", fields: {} });

describe("defineNode", () => {
  it("returns the input reference unchanged", () => {
    const node = {
      name: "noop",
      input: Person,
      output: single(Person),
      fn: (person: { age: number }) => person,
    };
    expect(defineNode(node)).toBe(node);
  });

  it("types a rhombus node and matches the step-zero netlist's birthday example", () => {
    // examples/person-birthday/netlist.json: Person { age: 41 } | birthday | expect Person { age: 42 }
    const birthday = defineNode({
      name: "birthday",
      input: Person,
      output: single(Person),
      fn: (person) => ({ age: person.age + 1 }),
      examples: [{ given: { age: 41 }, expect: { age: 42 } }],
    });

    for (const example of birthday.examples ?? []) {
      expect(birthday.fn(example.given)).toEqual(example.expect);
    }
  });

  it("types a oneOf node and matches the step-zero netlist's expect_Person_age_42", () => {
    const expectPersonAge42 = defineNode({
      name: "expect_Person_age_42",
      input: Person,
      output: oneOf(Pass, Fail),
      closure: { expected: { age: 42 } },
      fn: (person) =>
        person.age === 42 ? { edge: "Pass", payload: {} } : { edge: "Fail", payload: {} },
    });

    expect(expectPersonAge42.fn({ age: 42 })).toEqual({ edge: "Pass", payload: {} });
    expect(expectPersonAge42.fn({ age: 41 })).toEqual({ edge: "Fail", payload: {} });
  });

  it("types an origin node against Unit instead of null input", () => {
    // examples/person-birthday/netlist.json's origin_Person_literal, with input:null
    // resolved to input:Unit (docs/design.md §5: "the only special edge").
    const originPersonLiteral = defineNode({
      name: "origin_Person_literal",
      input: Unit,
      output: single(Person),
      closure: { literal: { age: 41 } },
      fn: () => ({ age: 41 }),
    });

    expect(originPersonLiteral.fn({})).toEqual({ age: 41 });
  });

  it("types an allOf node — every branch fires (docs/design-history.md, place_order example)", () => {
    const OrderPlaced = defineEdge({ name: "OrderPlaced", fields: {} });
    const InvoiceRequested = defineEdge({ name: "InvoiceRequested", fields: {} });
    const InventoryReserved = defineEdge({ name: "InventoryReserved", fields: {} });

    const placeOrder = defineNode({
      name: "place_order",
      input: OrderPlaced,
      output: allOf(InvoiceRequested, InventoryReserved),
      fn: () => [
        { edge: "InvoiceRequested", payload: {} },
        { edge: "InventoryReserved", payload: {} },
      ],
    });

    expect(placeOrder.fn({})).toEqual([
      { edge: "InvoiceRequested", payload: {} },
      { edge: "InventoryReserved", payload: {} },
    ]);
  });

  it("types a many node — N instances of one edge", () => {
    const siblings = defineNode({
      name: "siblings",
      input: Person,
      output: many(Person),
      fn: (person) => [{ age: person.age - 2 }, { age: person.age + 2 }],
    });

    expect(siblings.fn({ age: 10 })).toEqual([{ age: 8 }, { age: 12 }]);
  });
});
