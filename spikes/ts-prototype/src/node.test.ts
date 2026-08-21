import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineField, defineNode, many, oneOf, single } from "./define.js";
import { Unit } from "./types.js";

const Person = defineEdge({
  name: "Person",
  description: "A person",
  fields: { age: defineField({ type: "uint8", label: "Age", description: "The person's age" }) },
});

const Pass = defineEdge({ name: "Pass", description: "A passing test result", fields: {} });
const Fail = defineEdge({ name: "Fail", description: "A failing test result", fields: {} });

const Address = defineEdge({
  name: "Address",
  description: "A mailing address",
  fields: {
    street: defineField({ type: "utf8", label: "Street", description: "Street address" }),
  },
});

const PersonWithAddress = defineEdge({
  name: "PersonWithAddress",
  description: "A person with a nested address edge",
  fields: {
    name: defineField({ type: "utf8", label: "Name", description: "The person's name" }),
    address: Address,
  },
});

describe("defineNode", () => {
  it("returns the input reference unchanged", () => {
    const node = {
      name: "noop",
      input: Person,
      output: single(Person),
      fn: (person: { age: number }) => person,
      closure: { literal: { age: 42 } }
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
    const OrderPlaced = defineEdge({ name: "OrderPlaced", description: "An order was placed", fields: {} });
    const InvoiceRequested = defineEdge({
      name: "InvoiceRequested",
      description: "An invoice was requested",
      fields: {},
    });
    const InventoryReserved = defineEdge({
      name: "InventoryReserved",
      description: "Inventory was reserved",
      fields: {},
    });

    const placeOrder = defineNode({
      name: "place_order",
      input: OrderPlaced,
      output: allOf(InvoiceRequested, InventoryReserved),
      fn: () => [
        { edge: "InvoiceRequested", payload: {} },
        { edge: "InventoryReserved", payload: {} },
      ] as const,
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

  it("types a node whose input edge has a nested compound (edge-valued) field", () => {
    const greet = defineNode({
      name: "greet",
      input: PersonWithAddress,
      output: single(PersonWithAddress),
      fn: (person) => ({
        ...person,
        name: `${person.name} of ${person.address.street}`,
      }),
    });

    expect(greet.fn({ name: "Ada", address: { street: "1 Infinite Loop" } })).toEqual({
      name: "Ada of 1 Infinite Loop",
      address: { street: "1 Infinite Loop" },
    });
  });
});
