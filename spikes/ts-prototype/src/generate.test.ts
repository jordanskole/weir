import { describe, expect, it } from "vitest";
import { createRng, generateFieldValue } from "./generate.js";
import type { FieldDef, LiteralFieldDef } from "./types.js";

const ageField: FieldDef<"uint8", false> = {
  type: "uint8",
  label: "Age",
  description: "Age in years",
  nullable: false,
  validations: { min: 5, max: 10 },
};

const unboundedFloat: FieldDef<"f64", false> = {
  type: "f64",
  label: "Amount",
  description: "An unbounded float",
  nullable: false,
};

const nameField: FieldDef<"utf8", false> = {
  type: "utf8",
  label: "Name",
  description: "A short name",
  nullable: false,
  validations: { minLength: 2, maxLength: 4 },
};

const statusField: FieldDef<"utf8", false> = {
  type: "utf8",
  label: "Status",
  description: "A status",
  nullable: false,
  enumValues: ["a", "b", "c"],
};

const activeField: FieldDef<"bool"> = {
  type: "bool",
  label: "Active",
  description: "Whether active",
};

const doneField: LiteralFieldDef = { literal: true };

const codeField: FieldDef<"utf8", false> = {
  type: "utf8",
  label: "Code",
  description: "A code",
  nullable: false,
  validations: { pattern: "^[A-Z]{3}$" },
};

describe("createRng", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = createRng(7);
    const b = createRng(7);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0, 1)", () => {
    const rng = createRng(1);
    for (let i = 0; i < 50; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("generateFieldValue", () => {
  it("hits numeric boundaries (min, max) before falling back to in-range random", () => {
    const rng = createRng(1);
    expect(generateFieldValue("age", ageField, rng, 0)).toBe(5);
    expect(generateFieldValue("age", ageField, rng, 1)).toBe(10);
    for (let i = 2; i < 20; i++) {
      const value = generateFieldValue("age", ageField, rng, i) as number;
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(10);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("falls back to a pragmatic default range for an unbounded float field", () => {
    const rng = createRng(1);
    const value = generateFieldValue("amount", unboundedFloat, rng, 5) as number;
    expect(Number.isFinite(value)).toBe(true);
  });

  it("hits string-length boundaries (minLength, maxLength)", () => {
    const rng = createRng(2);
    expect((generateFieldValue("name", nameField, rng, 0) as string).length).toBe(2);
    expect((generateFieldValue("name", nameField, rng, 1) as string).length).toBe(4);
    for (let i = 2; i < 10; i++) {
      const value = generateFieldValue("name", nameField, rng, i) as string;
      expect(value.length).toBeGreaterThanOrEqual(2);
      expect(value.length).toBeLessThanOrEqual(4);
    }
  });

  it("cycles through every enumValues entry within one enumValues.length-sized batch", () => {
    const rng = createRng(3);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      seen.add(generateFieldValue("status", statusField, rng, i) as string);
    }
    expect(seen).toEqual(new Set(["a", "b", "c"]));
  });

  it("alternates true/false for a bool field", () => {
    const rng = createRng(4);
    expect(generateFieldValue("active", activeField, rng, 0)).toBe(true);
    expect(generateFieldValue("active", activeField, rng, 1)).toBe(false);
    expect(generateFieldValue("active", activeField, rng, 2)).toBe(true);
  });

  it("always returns a literal field's pinned constant", () => {
    const rng = createRng(5);
    expect(generateFieldValue("done", doneField, rng, 0)).toBe(true);
    expect(generateFieldValue("done", doneField, rng, 9)).toBe(true);
  });

  it("throws, naming the field, for a field declaring a pattern", () => {
    const rng = createRng(6);
    expect(() => generateFieldValue("code", codeField, rng, 0)).toThrow(/code/);
  });
});
