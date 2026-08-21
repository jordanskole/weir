import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { edgeSchema, fieldSchema, nodeSchema } from "./schema.js";

const ajv = new Ajv2020({ strict: false });

function validatorFor(schema: object) {
  return ajv.compile(schema);
}

describe("fieldSchema", () => {
  it("accepts a valid utf8 field with a pattern validation", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "email",
      type: "utf8",
      label: "Email",
      description: "An email address",
      validations: { pattern: "^[a-z]+$" },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a field missing required properties", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ type: "utf8" });
    expect(valid).toBe(false);
  });

  it("rejects an unknown scalar type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "x",
      type: "int64",
      label: "X",
      description: "d",
    });
    expect(valid).toBe(false);
  });

  it("rejects minLength/maxLength on a numeric field", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "age",
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { minLength: 1 },
    });
    expect(valid).toBe(false);
  });

  it("rejects pattern on a bool field", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "active",
      type: "bool",
      label: "Active",
      description: "d",
      validations: { pattern: "true" },
    });
    expect(valid).toBe(false);
  });

  it("rejects a uint8 min above its representable range", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "age",
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { max: 999 },
    });
    expect(valid).toBe(false);
  });

  it("rejects a negative min on an unsigned type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "age",
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { min: -5 },
    });
    expect(valid).toBe(false);
  });

  it("accepts a non-integer min/max on a float type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "amount",
      type: "f32",
      label: "Amount",
      description: "d",
      validations: { min: 1.5, max: 99.99 },
    });
    expect(valid).toBe(true);
  });
});

describe("edgeSchema", () => {
  it("accepts a valid edge with an inline scalar field", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "Address",
      description: "A mailing address",
      fields: {
        street: { type: "utf8", label: "Street", description: "Street address" },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a bare-string field value (a reference to a .field/.edge file)", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "PersonWithAddress",
      description: "d",
      fields: {
        email: "email",
        address: "Address",
      },
    });
    expect(valid).toBe(true);
  });

  it("rejects an edge missing required top-level properties", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({ fields: {} });
    expect(valid).toBe(false);
  });

  it("rejects an inline field with an unknown scalar type", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "Address",
      description: "d",
      fields: {
        street: { type: "int64", label: "Street", description: "d" },
      },
    });
    expect(valid).toBe(false);
  });

  it("rejects an inline field carrying a redundant name — the map key is the name", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "Address",
      description: "d",
      fields: {
        street: { name: "street", type: "utf8", label: "Street", description: "d" },
      },
    });
    expect(valid).toBe(false);
  });

  it("rejects the same type-appropriateness violations fieldSchema does, inline", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "Person",
      description: "d",
      fields: {
        age: {
          type: "uint8",
          label: "Age",
          description: "d",
          validations: { pattern: "^[0-9]+$" },
        },
      },
    });
    expect(valid).toBe(false);
  });
});

describe("nodeSchema", () => {
  it("accepts a minimal node with single-edge sugar for output", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "birthday",
      description: "d",
      input: "Person",
      output: "Person",
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a node missing required top-level properties", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({ name: "birthday" });
    expect(valid).toBe(false);
  });

  it("rejects a node carrying an fn key — contract only, no implementation", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "birthday",
      description: "d",
      input: "Person",
      output: "Person",
      fn: "() => {}",
    });
    expect(valid).toBe(false);
  });

  it("accepts a oneOf output", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "expect_Person_age_42",
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
    });
    expect(valid).toBe(true);
  });

  it("accepts an allOf output", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "place_order",
      description: "d",
      input: "OrderPlaced",
      output: { allOf: ["InvoiceRequested", "InventoryReserved"] },
    });
    expect(valid).toBe(true);
  });

  it("accepts a many output", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "siblings",
      description: "d",
      input: "Person",
      output: { many: "Person" },
    });
    expect(valid).toBe(true);
  });

  it("rejects an output with more than one shape key at once", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "bad",
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass"], allOf: ["Fail"] },
    });
    expect(valid).toBe(false);
  });

  it("accepts examples as a list of given/expect", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "birthday",
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { age: 41 }, expect: { age: 42 } }],
    });
    expect(valid).toBe(true);
  });

  it("accepts a closure with expected", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "expect_Person_age_42",
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
      closure: { expected: { age: 42 } },
    });
    expect(valid).toBe(true);
  });

  it("accepts a closure with literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "origin_Person_literal",
      description: "d",
      input: "Unit",
      output: "Person",
      closure: { literal: { age: 41 } },
    });
    expect(valid).toBe(true);
  });

  it("rejects a closure with both expected and literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "bad",
      description: "d",
      input: "Person",
      output: "Person",
      closure: { expected: { age: 41 }, literal: { age: 41 } },
    });
    expect(valid).toBe(false);
  });

  it("rejects a closure with neither expected nor literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "bad",
      description: "d",
      input: "Person",
      output: "Person",
      closure: {},
    });
    expect(valid).toBe(false);
  });
});
