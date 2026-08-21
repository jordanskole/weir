import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { edgeSchema, fieldSchema } from "./schema.js";

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
