import { describe, expect, it } from "vitest";
import { checkProperty, evaluateProperty } from "./property.js";
import type { PropertyDecl, PropertyExpr } from "./types.js";

const scope = {
  input: { age: 41, name: "ada" },
  output: { age: 42, name: "ada" },
};

function evalIn(expr: PropertyExpr, s: { input: unknown; output: unknown } = scope): unknown {
  return evaluateProperty(expr, s);
}

describe("evaluateProperty — leaves", () => {
  it("returns a literal unchanged", () => {
    expect(evalIn({ lit: 1 })).toBe(1);
    expect(evalIn({ lit: "x" })).toBe("x");
    expect(evalIn({ lit: true })).toBe(true);
    expect(evalIn({ lit: null })).toBe(null);
  });

  it("resolves a path into input and into output", () => {
    expect(evalIn({ get: "input.age" })).toBe(41);
    expect(evalIn({ get: "output.age" })).toBe(42);
  });

  it("resolves a nested path (an allOf bag, or a oneOf payload)", () => {
    const nested = { input: { Person: { age: 7 } }, output: { edge: "Pass", payload: { ok: true } } };
    expect(evalIn({ get: "input.Person.age" }, nested)).toBe(7);
    expect(evalIn({ get: "output.edge" }, nested)).toBe("Pass");
    expect(evalIn({ get: "output.payload.ok" }, nested)).toBe(true);
  });

  it("throws when a path does not start at input or output", () => {
    expect(() => evalIn({ get: "env.id" })).toThrow(/must start with "input" or "output"/);
  });

  it("throws when a path does not resolve, rather than yielding undefined", () => {
    expect(() => evalIn({ get: "input.nope" })).toThrow(/does not resolve/);
    expect(() => evalIn({ get: "input.age.deeper" })).toThrow(/does not resolve/);
  });
});

describe("evaluateProperty — operators", () => {
  it("compares with eq/ne, structurally", () => {
    expect(evalIn({ eq: [{ get: "input.name" }, { get: "output.name" }] })).toBe(true);
    expect(evalIn({ ne: [{ get: "input.age" }, { get: "output.age" }] })).toBe(true);
    expect(evalIn({ eq: [{ lit: 1 }, { lit: 2 }] })).toBe(false);
  });

  it("orders numbers and strings, and rejects mixed or unorderable operands", () => {
    expect(evalIn({ lt: [{ get: "input.age" }, { get: "output.age" }] })).toBe(true);
    expect(evalIn({ gte: [{ lit: 2 }, { lit: 2 }] })).toBe(true);
    expect(evalIn({ lt: [{ lit: "a" }, { lit: "b" }] })).toBe(true);
    expect(() => evalIn({ lt: [{ lit: 1 }, { lit: "b" }] })).toThrow(/two numbers or two strings/);
    expect(() => evalIn({ lt: [{ lit: true }, { lit: false }] })).toThrow(/two numbers or two strings/);
  });

  it("does arithmetic on numbers and rejects anything else", () => {
    expect(evalIn({ add: [{ get: "input.age" }, { lit: 1 }] })).toBe(42);
    expect(evalIn({ sub: [{ get: "output.age" }, { lit: 1 }] })).toBe(41);
    expect(() => evalIn({ add: [{ lit: "a" }, { lit: 1 }] })).toThrow(/needs a number/);
  });

  it("combines with and/or/not", () => {
    expect(evalIn({ and: [{ lit: true }, { lit: true }] })).toBe(true);
    expect(evalIn({ and: [{ lit: true }, { lit: false }] })).toBe(false);
    expect(evalIn({ or: [{ lit: false }, { lit: true }] })).toBe(true);
    expect(evalIn({ not: { lit: false } })).toBe(true);
    expect(() => evalIn({ not: { lit: 1 } })).toThrow(/needs a boolean/);
  });

  it("implements implies with the standard truth table, vacuous antecedent included", () => {
    const t = { lit: true } as const;
    const f = { lit: false } as const;
    expect(evalIn({ implies: [t, t] })).toBe(true);
    expect(evalIn({ implies: [t, f] })).toBe(false);
    expect(evalIn({ implies: [f, t] })).toBe(true);
    expect(evalIn({ implies: [f, f] })).toBe(true);
  });

  it("evaluates §6's own example", () => {
    const birthdayIncrementsAge: PropertyExpr = {
      eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }],
    };
    expect(evalIn(birthdayIncrementsAge)).toBe(true);
    expect(evalIn(birthdayIncrementsAge, { input: { age: 41 }, output: { age: 41 } })).toBe(false);
  });
});

describe("checkProperty", () => {
  const property: PropertyDecl = {
    name: "increments age by one",
    description: "A birthday advances the person's age by exactly one year.",
    expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
  };

  it("returns the boolean result", () => {
    expect(checkProperty(property, scope)).toBe(true);
    expect(checkProperty(property, { input: { age: 41 }, output: { age: 99 } })).toBe(false);
  });

  it("names the property when its expression is broken", () => {
    expect(() => checkProperty(property, { input: {}, output: {} })).toThrow(/increments age by one/);
  });

  it("throws when a property does not evaluate to a boolean", () => {
    const notBoolean: PropertyDecl = { ...property, name: "bad", expr: { get: "input.age" } };
    expect(() => checkProperty(notBoolean, scope)).toThrow(/must evaluate to a boolean/);
  });
});
