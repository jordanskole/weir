import { describe, expect, it } from "vitest";
import { createRng, generateFieldValue, generateInputCases, generatePayload } from "./generate.js";
import type { AnyEdgeDef, FieldDef, InputSpec, LiteralFieldDef } from "./types.js";
import { assertPayload } from "./membrane.js";

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

const dateWithPatternField: FieldDef<"datetime", false> = {
  type: "datetime",
  label: "Timestamp",
  description: "A timestamp with pattern",
  nullable: false,
  validations: { pattern: "^2024" },
};

const tightRangeField: FieldDef<"uint8", false> = {
  type: "uint8",
  label: "Tight",
  description: "A tight range",
  nullable: false,
  validations: { min: 5, max: 5 },
};

const narrowRangeField: FieldDef<"uint8", false> = {
  type: "uint8",
  label: "Narrow",
  description: "A narrow range",
  nullable: false,
  validations: { min: 5, max: 6 },
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

  it("throws, naming the field, for a datetime field declaring a pattern", () => {
    const rng = createRng(7);
    expect(() => generateFieldValue("timestamp", dateWithPatternField, rng, 0)).toThrow(/timestamp/);
  });

  it("never generates values outside [min, max] when min === max", () => {
    const rng = createRng(8);
    for (let i = 0; i < 20; i++) {
      const value = generateFieldValue("tight", tightRangeField, rng, i) as number;
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(5);
    }
  });

  it("never generates values outside [min, max] when min + 1 === max", () => {
    const rng = createRng(9);
    for (let i = 0; i < 20; i++) {
      const value = generateFieldValue("narrow", narrowRangeField, rng, i) as number;
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(6);
    }
  });
});

const Person: AnyEdgeDef = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: ageField,
    name: nameField,
  },
};

const Todo: AnyEdgeDef = {
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: { type: "utf8", label: "ID", description: "d", nullable: false, validations: { minLength: 1, maxLength: 8 } },
    is_complete: doneField,
  },
};

const TodoList: AnyEdgeDef = {
  name: "TodoList",
  label: "Todo List",
  description: "A list of todos",
  fields: {
    title: nameField,
    todos: { many: Todo },
  },
};

const Tag: AnyEdgeDef = {
  name: "Tag",
  label: "Tag",
  description: "A tag with an enum index",
  index: "priority",
  fields: {
    priority: { type: "utf8", label: "Priority", description: "Priority level", nullable: false, enumValues: ["high", "medium", "low"] },
  },
};

const TagCollection: AnyEdgeDef = {
  name: "TagCollection",
  label: "Tag Collection",
  description: "A collection of tags",
  fields: {
    tags: { many: Tag },
  },
};

describe("generatePayload", () => {
  it("generates a payload that passes assertPayload against its own edge", () => {
    const rng = createRng(10);
    for (let i = 0; i < 20; i++) {
      const payload = generatePayload(Person, rng, i);
      expect(() => assertPayload(Person, payload)).not.toThrow();
    }
  });

  it("recurses into a many field, producing a collection keyed by the referenced edge's index", () => {
    const rng = createRng(11);
    const payload = generatePayload(TodoList, rng, 5) as { todos: Record<string, { id: string }> };
    expect(() => assertPayload(TodoList, payload)).not.toThrow();
    for (const [key, todo] of Object.entries(payload.todos)) {
      expect(todo.id).toBe(key);
    }
  });

  it("diversifies caseIndex for each entry in a many field to avoid collisions on enum-indexed edges", () => {
    // Generate many payloads at caseIndex 0, where enumValues would collapse all entries to the same
    // enum value without diversifying caseIndex. We expect to see multiple unique keys across samples.
    const uniqueKeys = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const rng = createRng(seed);
      const payload = generatePayload(TagCollection, rng, 0) as { tags: Record<string, { priority: string }> };
      expect(() => assertPayload(TagCollection, payload)).not.toThrow();
      Object.keys(payload.tags).forEach((key) => uniqueKeys.add(key));
    }
    // With diversified caseIndex, we should see at least 2 different enum values across 20 samples
    expect(uniqueKeys.size).toBeGreaterThan(1);
  });
});

describe("generateInputCases", () => {
  it("generates `count` valid payloads for a single-kind InputSpec", () => {
    const input: InputSpec = { kind: "single", edge: Person };
    const cases = generateInputCases(input, 20, 15);
    expect(cases).toHaveLength(15);
    for (const c of cases) {
      expect(() => assertPayload(Person, c)).not.toThrow();
    }
  });

  it("generates `count` bags keyed by edge name for an allOf-kind InputSpec", () => {
    const input: InputSpec = { kind: "allOf", edges: [TodoList, Todo] };
    const cases = generateInputCases(input, 21, 10) as Record<string, unknown>[];
    expect(cases).toHaveLength(10);
    for (const bag of cases) {
      expect(Object.keys(bag).sort()).toEqual(["Todo", "TodoList"]);
      expect(() => assertPayload(TodoList, bag.TodoList)).not.toThrow();
      expect(() => assertPayload(Todo, bag.Todo)).not.toThrow();
    }
  });

  it("is deterministic: the same seed produces the same cases", () => {
    const input: InputSpec = { kind: "single", edge: Person };
    expect(generateInputCases(input, 99, 5)).toEqual(generateInputCases(input, 99, 5));
  });
});
