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

const dateWithUnsatisfiableLengthField: FieldDef<"datetime", false> = {
  type: "datetime",
  label: "Timestamp",
  description: "A timestamp with an unsatisfiable maxLength",
  nullable: false,
  validations: { maxLength: 10 },
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

  /**
   * Asserted as a set rather than per index, because the boundary lengths grew
   * from {minLength, maxLength} to {minLength, minLength+1, maxLength-1,
   * maxLength} and the old test pinned case 1 to maxLength specifically. The
   * intent was always "the boundaries get generated", so this says that.
   *
   * Uses a field whose bounds are wider than the ordinary span, deliberately.
   * A first version used nameField (minLength 2 / maxLength 4) and passed under a
   * break that removed two of the four boundaries — because with a 3-wide range the
   * ordinary random draw reaches the "missing" boundary by chance. The upper
   * boundaries here (99, 100) sit above the ordinary span, so only the boundary
   * path can produce them.
   */
  it("hits every string-length boundary, and stays in range afterwards", () => {
    const wide = {
      type: "utf8",
      label: "Wide",
      description: "bounds wider than the ordinary span",
      nullable: false,
      validations: { minLength: 2, maxLength: 100 },
    } as unknown as typeof nameField;

    const rng = createRng(2);
    const first = Array.from({ length: 4 }, (_, i) =>
      (generateFieldValue("wide", wide, rng, i) as string).length,
    );
    expect(new Set(first)).toEqual(new Set([2, 3, 99, 100]));

    for (let i = 4; i < 20; i++) {
      const value = generateFieldValue("wide", wide, rng, i) as string;
      expect(value.length).toBeGreaterThanOrEqual(2);
      expect(value.length).toBeLessThanOrEqual(100);
    }
  });

  /**
   * The reason the length distribution changed at all.
   *
   * A generous `maxLength` used to make every non-boundary case average half of
   * it: blue-ribbon's `boundaryJson` (maxLength 2,000,000) produced a median of
   * 1,157,240 characters and 108 MB over the gate's 100 cases. The bound is still
   * exercised — once at the maximum and once just below — and everything else is
   * an ordinary length near the floor.
   *
   * BREAK-PROOF: reverting the `ordinaryMax` clamp to `maxLength` reddens this on
   * the median, and reddens nothing else in the suite — which is why this test
   * has to exist rather than relying on the boundary test above.
   */
  it("does not pay for a generous maxLength on every case", () => {
    const bulk = {
      type: "utf8",
      label: "Bulk",
      description: "a field with a generous bound",
      nullable: false,
      validations: { minLength: 2, maxLength: 2_000_000 },
    } as unknown as typeof nameField;

    const rng = createRng(42);
    const lengths = Array.from({ length: 100 }, (_, i) =>
      (generateFieldValue("bulk", bulk, rng, i) as string).length,
    );
    const sorted = [...lengths].sort((a, b) => a - b);

    // Both ends of the declared bound are still reached, exactly once each.
    expect(lengths.filter((n) => n === 2_000_000)).toHaveLength(1);
    expect(lengths.filter((n) => n === 1_999_999)).toHaveLength(1);
    expect(sorted[0]).toBe(2);

    // And the typical case is ordinary rather than a megabyte.
    expect(sorted[50]).toBeLessThan(100);
    const total = lengths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(5_000_000);
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

  it("throws, naming the field, for a datetime field declaring a minLength/maxLength a 24-char ISO string can't satisfy", () => {
    const rng = createRng(7);
    expect(() => generateFieldValue("timestamp", dateWithUnsatisfiableLengthField, rng, 0)).toThrow(/timestamp/);
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
