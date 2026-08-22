import { describe, expect, it } from "vitest";
import { defineEdge, defineField } from "./define.js";
import type { EdgeDef, FieldDef } from "./types.js";

/** Every FieldDef requires label/description; this test file doesn't exercise that, so share it. */
const meta = { label: "Test", description: "A test field", nullable: false };

describe("defineField", () => {
  it("returns the input reference unchanged", () => {
    const field: FieldDef<"uint8"> = { type: "uint8", ...meta };
    expect(defineField(field)).toBe(field);
  });

  it("rejects a negative min on an unsigned type", () => {
    expect(() => defineField({ type: "uint8", ...meta, validations: { min: -5 } })).toThrow(/min/i);
  });

  it("rejects min greater than max", () => {
    expect(() =>
      defineField({ type: "int8", ...meta, validations: { min: 10, max: 5 } }),
    ).toThrow(/min.*max/i);
  });

  it("rejects minLength on a numeric field", () => {
    expect(() =>
      defineField({
        type: "uint8",
        ...meta,
        validations: { minLength: 1 },
      } as unknown as FieldDef<"uint8">),
    ).toThrow(/minLength/i);
  });

  it("rejects min on a bool field", () => {
    expect(() =>
      defineField({
        type: "bool",
        label: "Test",
        description: "A test field",
        validations: { min: 0 },
      } as unknown as FieldDef<"bool">),
    ).toThrow(/min/i);
  });

  it("rejects min on a utf8 field", () => {
    expect(() =>
      defineField({
        type: "utf8",
        ...meta,
        validations: { min: 0 },
      } as unknown as FieldDef<"utf8">),
    ).toThrow(/min/i);
  });

  it("rejects pattern on a non-utf8 field", () => {
    expect(() =>
      defineField({
        type: "uint8",
        ...meta,
        validations: { pattern: "^[0-9]+$" },
      } as unknown as FieldDef<"uint8">),
    ).toThrow(/pattern/i);
  });

  it("rejects a max above uint8's representable range", () => {
    expect(() =>
      defineField({ type: "uint8", ...meta, validations: { max: 999 } }),
    ).toThrow(/range/i);
  });

  it("rejects a min below int8's representable range", () => {
    expect(() =>
      defineField({ type: "int8", ...meta, validations: { min: -200 } }),
    ).toThrow(/range/i);
  });

  it("rejects a non-integer min on an integer type", () => {
    expect(() =>
      defineField({ type: "uint8", ...meta, validations: { min: 1.5 } }),
    ).toThrow(/integer/i);
  });

  it("allows a non-integer min on a float type", () => {
    expect(() =>
      defineField({ type: "f32", ...meta, validations: { min: 1.5 } }),
    ).not.toThrow();
  });

  it("rejects minLength greater than maxLength", () => {
    expect(() =>
      defineField({ type: "utf8", ...meta, validations: { minLength: 10, maxLength: 5 } }),
    ).toThrow(/minLength.*maxLength/i);
  });

  it("rejects a negative minLength", () => {
    expect(() =>
      defineField({ type: "utf8", ...meta, validations: { minLength: -1 } }),
    ).toThrow(/minLength/i);
  });

  it("rejects an invalid regex pattern", () => {
    expect(() =>
      defineField({ type: "utf8", ...meta, validations: { pattern: "(unterminated" } }),
    ).toThrow(/regex|pattern/i);
  });

  it("allows a uint8 field with min/max within range", () => {
    expect(() =>
      defineField({ type: "uint8", ...meta, validations: { min: 0, max: 120 } }),
    ).not.toThrow();
  });

  it("allows a utf8 field with minLength/maxLength/pattern", () => {
    expect(() =>
      defineField({
        type: "utf8",
        ...meta,
        validations: { minLength: 0, maxLength: 40, pattern: "^[a-z]+$" },
      }),
    ).not.toThrow();
  });

  it("rejects enumValues on a non-utf8 field", () => {
    expect(() =>
      defineField({ type: "uint8", ...meta, enumValues: ["a", "b"] } as FieldDef<"uint8">),
    ).toThrow(/enumValues/i);
  });

  it("rejects enumValues combined with pattern", () => {
    expect(() =>
      defineField({
        type: "utf8",
        ...meta,
        enumValues: ["a", "b"],
        validations: { pattern: "^[a-z]+$" },
      } as FieldDef<"utf8">),
    ).toThrow(/enumValues/i);
  });

  it("rejects enumValues combined with minLength/maxLength", () => {
    expect(() =>
      defineField({
        type: "utf8",
        ...meta,
        enumValues: ["a", "b"],
        validations: { maxLength: 10 },
      } as FieldDef<"utf8">),
    ).toThrow(/enumValues/i);
  });

  it("allows enumValues alone on a utf8 field", () => {
    expect(() =>
      defineField({ type: "utf8", ...meta, enumValues: ["a", "b"] } as FieldDef<"utf8">),
    ).not.toThrow();
  });

  it("allows a datetime field with pattern/minLength/maxLength", () => {
    expect(() =>
      defineField({
        type: "datetime",
        ...meta,
        validations: { pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
      }),
    ).not.toThrow();
  });

  it("rejects min/max on a datetime field", () => {
    expect(() =>
      defineField({ type: "datetime", ...meta, validations: { min: 0 } } as unknown as FieldDef<"datetime">),
    ).toThrow(/min/i);
  });

  it("rejects a non-bool field missing nullable", () => {
    expect(() =>
      defineField({ type: "uint8", label: "Test", description: "d" } as unknown as FieldDef<"uint8">),
    ).toThrow(/nullable/i);
  });

  it("rejects a bool field that declares nullable", () => {
    expect(() =>
      defineField({
        type: "bool",
        label: "Test",
        description: "d",
        nullable: false,
      } as unknown as FieldDef<"bool">),
    ).toThrow(/nullable/i);
  });

  it("allows a bool field with no nullable key", () => {
    expect(() =>
      defineField({ type: "bool", label: "Test", description: "d" }),
    ).not.toThrow();
  });

  it("allows a nullable non-bool field", () => {
    expect(() =>
      defineField({ type: "uint8", label: "Test", description: "d", nullable: true }),
    ).not.toThrow();
  });
});

describe("defineEdge", () => {
  it("returns the input reference unchanged", () => {
    const edge: EdgeDef = {
      name: "Person",
      label: "Person",
      description: "A test edge",
      fields: { age: { type: "uint8", ...meta } },
    };
    expect(defineEdge(edge)).toBe(edge);
  });
});
