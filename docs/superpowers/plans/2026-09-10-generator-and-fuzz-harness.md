# Property-Test Generation and Structural Fuzz Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a seeded, boundary-biased per-field/per-edge generator (`generate.ts`) on the TypeScript spike prototype, and a fuzz harness (`fuzz.ts`) that runs generated inputs through a node's real `Fn` (via `membrane()`) and reports any case whose result is structurally neither a valid `OutputSpec` match nor a valid `Failed<In>`.

**Architecture:** `generate.ts` is pure and depends only on `types.ts` (plus `INTEGER_RANGES` reused from `define.ts`) — no knowledge of `Fn`, `membrane`, or node declarations. `fuzz.ts` depends on `generate.ts` and `membrane.ts` (`membrane`, `assertPayload`, `Log`, `InMemoryLog`, all already exported) and `runtime.ts` (`looksLikeFailed`, newly exported by this plan). Neither module changes `elaborate.ts`, `hash.ts`, or any node/edge declaration format — both are additive, standalone, and callable from tests today, the same shape `contract.ts`/`metadata.ts` already are.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-generator-and-fuzz-harness.md` — this plan implements it in full. Read its Motivation and Design sections before Task 1.

## Global Constraints

- All source work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- Follow TDD: write/modify the test first, confirm it fails for the right reason, then write the minimal implementation change, then confirm it passes.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's own convention).
- Commit after each task, one task per commit.
- This is a personal project with a work-hours commit convention: if the real time falls inside 9am–5pm on a weekday when you commit, shift the commit's timestamp outside that window using `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible time the same day, rather than committing with the real in-hours timestamp. Check `date` before each commit.
- No new npm dependencies — the seeded PRNG is a small inline implementation (mulberry32-shaped), not a library.
- A field declaring `validations.pattern` makes generation throw immediately, naming the field — never silently generate a non-matching string.

---

## Task 1: `generate.ts` — seeded PRNG and per-field scalar generation

**Files:**
- Create: `spikes/ts-prototype/src/generate.ts`
- Test: `spikes/ts-prototype/src/generate.test.ts`

**Interfaces:**
- Consumes: `FieldDef`, `LiteralFieldDef`, `ScalarType` (`types.ts`, unchanged); `INTEGER_RANGES` (`define.ts`, already exported, unchanged).
- Produces: `Rng` (type alias, internal — not exported from `index.ts`), `createRng(seed: number): Rng`, `generateFieldValue(fieldKey: string, field: FieldDef | LiteralFieldDef, rng: Rng, caseIndex: number): unknown` — both consumed by Task 2's `generatePayload`.

- [ ] **Step 1: Write the failing tests**

Create `spikes/ts-prototype/src/generate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run generate.test.ts`
Expected: fails to collect/typecheck — `./generate.js` doesn't exist yet.

- [ ] **Step 3: Implement `generate.ts`**

Create `spikes/ts-prototype/src/generate.ts`:

```ts
/**
 * Property-test generation (docs/design.md §6; docs/superpowers/specs/
 * 2026-09-10-generator-and-fuzz-harness.md) — a seeded, boundary-biased
 * per-field generator derived from FieldDef's own type/enumValues/
 * validations, the same "mechanically derivable from the same types" move
 * contract.ts and schema.ts already make off the same source.
 */

import { INTEGER_RANGES } from "./define.js";
import type { FieldDef, LiteralFieldDef, ScalarType } from "./types.js";

export type Rng = () => number;

/**
 * mulberry32 — a small, deterministic, dependency-free PRNG. Same seed,
 * same sequence, always: what makes a generated batch reproducible across
 * runs rather than flaky.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** A pragmatic sampling range for f32/f64 fields — these have no representable-range check (INTEGER_RANGES has no entry for them), but generation still needs *some* concrete domain to sample uniform-random fill from. Not a spec requirement, an implementation default. */
const DEFAULT_FLOAT_BOUND = 1_000_000;

function isIntegerType(type: ScalarType): boolean {
  return type in INTEGER_RANGES;
}

function numericBounds(field: FieldDef): [number, number] {
  const v = field.validations as { min?: number; max?: number } | undefined;
  const range = INTEGER_RANGES[field.type];
  const min = v?.min ?? range?.[0] ?? -DEFAULT_FLOAT_BOUND;
  const max = v?.max ?? range?.[1] ?? DEFAULT_FLOAT_BOUND;
  return [min, max];
}

function generateNumericValue(field: FieldDef, rng: Rng, caseIndex: number): number {
  const [min, max] = numericBounds(field);
  const boundaries = Array.from(
    new Set(
      [min, max, min + 1, max - 1, min <= 0 && 0 <= max ? 0 : undefined].filter(
        (v): v is number => v !== undefined,
      ),
    ),
  );
  if (caseIndex < boundaries.length) return boundaries[caseIndex];
  const raw = min + rng() * (max - min);
  return isIntegerType(field.type) ? Math.round(raw) : raw;
}

const MIN_DATETIME = Date.parse("2000-01-01T00:00:00.000Z");
const MAX_DATETIME = Date.parse("2030-01-01T00:00:00.000Z");

function generateDatetimeValue(rng: Rng, caseIndex: number): string {
  const boundaries = [MIN_DATETIME, MAX_DATETIME];
  const millis = caseIndex < boundaries.length ? boundaries[caseIndex] : randomInt(rng, MIN_DATETIME, MAX_DATETIME);
  return new Date(millis).toISOString();
}

const PRINTABLE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";

function generateStringValue(fieldKey: string, field: FieldDef, rng: Rng, caseIndex: number): string {
  const v = field.validations as { minLength?: number; maxLength?: number; pattern?: string } | undefined;
  if (v?.pattern !== undefined) {
    throw new Error(
      `generate: field "${fieldKey}" declares a pattern — generating strings that satisfy an arbitrary regex isn't supported (docs/superpowers/specs/2026-09-10-generator-and-fuzz-harness.md).`,
    );
  }
  const minLength = v?.minLength ?? 0;
  const maxLength = v?.maxLength ?? 64;
  const boundaryLengths = Array.from(new Set([minLength, maxLength]));
  const length = caseIndex < boundaryLengths.length ? boundaryLengths[caseIndex] : randomInt(rng, minLength, maxLength);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += PRINTABLE_CHARS[randomInt(rng, 0, PRINTABLE_CHARS.length - 1)];
  }
  return result;
}

/**
 * Generates one value for a single scalar or literal field. `caseIndex` is
 * this value's position within its batch — boundary values (numeric
 * min/max, string min/maxLength, every enumValues entry, bool
 * true-then-false) are front-loaded onto the earliest indices, uniform
 * random fills the rest, so a batch's first several cases are always the
 * cases a hand-written example set is least likely to include.
 */
export function generateFieldValue(
  fieldKey: string,
  field: FieldDef | LiteralFieldDef,
  rng: Rng,
  caseIndex: number,
): unknown {
  if ("literal" in field) return field.literal;

  if (field.enumValues !== undefined) {
    return field.enumValues[caseIndex % field.enumValues.length];
  }

  if (field.type === "bool") return caseIndex % 2 === 0;

  if (field.type === "datetime") return generateDatetimeValue(rng, caseIndex);

  if (field.type === "utf8") return generateStringValue(fieldKey, field, rng, caseIndex);

  return generateNumericValue(field, rng, caseIndex);
}
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run generate.test.ts`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/generate.ts spikes/ts-prototype/src/generate.test.ts
git commit -m "Add generate.ts: seeded PRNG and boundary-biased per-field generation"
```

---

## Task 2: `generate.ts` — payload recursion and `generateInputCases`

**Files:**
- Modify: `spikes/ts-prototype/src/generate.ts`
- Test: `spikes/ts-prototype/src/generate.test.ts`

**Interfaces:**
- Consumes: `generateFieldValue`, `createRng`, `Rng` (Task 1, this file); `AnyEdgeDef`, `InputSpec` (`types.ts`, unchanged).
- Produces: `generatePayload(edge: AnyEdgeDef, rng: Rng, caseIndex: number): Record<string, unknown>`, `generateInputCases(input: InputSpec, seed: number, count: number): unknown[]` — both consumed by Task 4's `fuzzNode`.

- [ ] **Step 1: Write the failing tests**

Append to `spikes/ts-prototype/src/generate.test.ts` (add these imports to the existing `import` line and fixtures, then the new `describe` blocks):

```ts
// Add to the existing import from "./generate.js":
import { createRng, generateFieldValue, generateInputCases, generatePayload } from "./generate.js";
// Add to the existing import from "./types.js":
import type { AnyEdgeDef, FieldDef, InputSpec, LiteralFieldDef } from "./types.js";
// New import, used only to check generated payloads are actually valid:
import { assertPayload } from "./membrane.js";

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
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run generate.test.ts`
Expected: `generateInputCases`/`generatePayload` not exported — fails to collect/typecheck.

- [ ] **Step 3: Implement `generatePayload` and `generateInputCases`**

Append to `spikes/ts-prototype/src/generate.ts`:

```ts
import type { AnyEdgeDef, InputSpec } from "./types.js";

function generateManyValue(edge: AnyEdgeDef, rng: Rng, caseIndex: number): Record<string, unknown> {
  if (edge.index === undefined) {
    throw new Error(`generate: "${edge.name}" is used as a many-collection but declares no index.`);
  }
  const count = randomInt(rng, 0, 3);
  const collection: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const entry = generatePayload(edge, rng, caseIndex);
    const key = String(entry[edge.index]);
    collection[key] = entry;
  }
  return collection;
}

/**
 * Generates one full payload for `edge`, recursing into compound (nested
 * AnyEdgeDef) and many fields — the same three-way discriminant
 * assertPayload/hash.ts's fingerprint() already use ("many" in field /
 * "fields" in field / scalar-or-literal), applied here to generate rather
 * than validate.
 */
export function generatePayload(edge: AnyEdgeDef, rng: Rng, caseIndex: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, fieldDef] of Object.entries(edge.fields)) {
    if ("many" in fieldDef) {
      result[key] = generateManyValue(fieldDef.many, rng, caseIndex);
      continue;
    }
    if ("fields" in fieldDef) {
      result[key] = generatePayload(fieldDef, rng, caseIndex);
      continue;
    }
    result[key] = generateFieldValue(key, fieldDef, rng, caseIndex);
  }
  return result;
}

/**
 * The entry point a fuzz harness calls: `count` generated cases for a
 * node's declared InputSpec. `single` generates a payload per case;
 * `allOf` generates a bag keyed by edge name per case, matching
 * InputPayload's own allOf shape (types.ts).
 */
export function generateInputCases(input: InputSpec, seed: number, count: number): unknown[] {
  const rng = createRng(seed);
  const cases: unknown[] = [];
  for (let i = 0; i < count; i++) {
    if (input.kind === "single") {
      cases.push(generatePayload(input.edge, rng, i));
    } else {
      const bag: Record<string, unknown> = {};
      for (const edge of input.edges) {
        bag[edge.name] = generatePayload(edge, rng, i);
      }
      cases.push(bag);
    }
  }
  return cases;
}
```

Move the `import type { AnyEdgeDef, InputSpec } from "./types.js";` line up to join `generate.ts`'s existing `import type { FieldDef, LiteralFieldDef, ScalarType } from "./types.js";` line (one combined type-only import from `"./types.js"`) rather than leaving two separate import statements from the same module.

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run generate.test.ts`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/generate.ts spikes/ts-prototype/src/generate.test.ts
git commit -m "Add generatePayload/generateInputCases: recursive edge and input generation"
```

---

## Task 3: `fuzz.ts` — structural output validation

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts:84` (export the existing `looksLikeFailed`)
- Create: `spikes/ts-prototype/src/fuzz.ts`
- Test: `spikes/ts-prototype/src/fuzz.test.ts`

**Interfaces:**
- Consumes: `assertPayload` (`membrane.ts`, already exported, unchanged); `looksLikeFailed` (`runtime.ts`, newly exported by this task); `AnyEdgeDef`, `OutputSpec` (`types.ts`, unchanged).
- Produces: `resultMatchesOutput(output: OutputSpec, result: unknown): boolean`, `isAcceptableResult(output: OutputSpec, result: unknown): boolean` — both from `fuzz.ts`, consumed by Task 4's `fuzzNode`.

- [ ] **Step 1: Export `looksLikeFailed` from `runtime.ts`**

```ts
// runtime.ts:84, before:
function looksLikeFailed(result: unknown): result is Failed<InputSpec> {

// after:
export function looksLikeFailed(result: unknown): result is Failed<InputSpec> {
```

No other change to `runtime.ts` — the function body, and every existing call site, stay exactly as they are.

Run: `cd spikes/ts-prototype && npx vitest run runtime.test.ts`
Expected: unaffected, still passing (a pure visibility change).

- [ ] **Step 2: Write the failing tests**

Create `spikes/ts-prototype/src/fuzz.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defineEdge, defineField } from "./define.js";
import { isAcceptableResult, resultMatchesOutput } from "./fuzz.js";
import type { OutputSpec } from "./types.js";

/**
 * Built with defineEdge/defineField, not a raw `: AnyEdgeDef`-annotated
 * literal — this is what lets Task 4's defineNode(single(Person))/
 * defineNode(allOf(Person, Todo)) infer each node's Fn `payload` parameter
 * as a real, narrow object type (`{ age: number }`, not `unknown`), the
 * same inference trick membrane.test.ts's own fixtures already rely on. A
 * `: AnyEdgeDef` annotation here would erase that before it ever reaches
 * defineNode.
 */
const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }),
  },
});

const Pass = defineEdge({ name: "Pass", label: "Pass", description: "A passing result", fields: {} });
const Fail = defineEdge({ name: "Fail", label: "Fail", description: "A failing result", fields: {} });

const Todo = defineEdge({
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: defineField({ type: "utf8", label: "ID", description: "d", nullable: false }),
  },
});

describe("resultMatchesOutput", () => {
  it("accepts a valid single-output payload, rejects an invalid one", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(resultMatchesOutput(output, { age: 41 })).toBe(true);
    expect(resultMatchesOutput(output, { age: "not a number" })).toBe(false);
  });

  it("accepts a correctly-tagged oneOf branch, rejects an unlisted edge name", () => {
    const output: OutputSpec = { kind: "oneOf", edges: [Pass, Fail] };
    expect(resultMatchesOutput(output, { edge: "Pass", payload: {} })).toBe(true);
    expect(resultMatchesOutput(output, { edge: "Nope", payload: {} })).toBe(false);
  });

  it("accepts every declared edge tagged for allOf, rejects a missing branch", () => {
    const output: OutputSpec = { kind: "allOf", edges: [Pass, Fail] };
    expect(
      resultMatchesOutput(output, [
        { edge: "Pass", payload: {} },
        { edge: "Fail", payload: {} },
      ]),
    ).toBe(true);
    expect(resultMatchesOutput(output, [{ edge: "Pass", payload: {} }])).toBe(false);
  });

  it("accepts a many output keyed correctly by the edge's index, rejects a mis-keyed entry", () => {
    const output: OutputSpec = { kind: "many", edge: Todo };
    expect(resultMatchesOutput(output, { "t1": { id: "t1" } })).toBe(true);
    expect(resultMatchesOutput(output, { "wrong-key": { id: "t1" } })).toBe(false);
  });
});

describe("isAcceptableResult", () => {
  it("accepts a Failed<In>-shaped result regardless of the declared output kind", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(isAcceptableResult(output, { input: { age: 41 } })).toBe(true);
    expect(isAcceptableResult(output, { input: { age: 41 }, reason: "boom" })).toBe(true);
  });

  it("rejects a result matching neither the output shape nor Failed<In>", () => {
    const output: OutputSpec = { kind: "single", edge: Person };
    expect(isAcceptableResult(output, { garbage: true })).toBe(false);
  });
});
```

- [ ] **Step 3: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run fuzz.test.ts`
Expected: fails to collect/typecheck — `./fuzz.js` doesn't exist yet.

- [ ] **Step 4: Implement `fuzz.ts`'s output validation**

Create `spikes/ts-prototype/src/fuzz.ts`:

```ts
/**
 * The structural fuzz harness (docs/superpowers/specs/2026-09-10-
 * generator-and-fuzz-harness.md) — runs generated inputs through a node's
 * real Fn via membrane() and checks the result is structurally either a
 * valid OutputSpec match or a valid Failed<In>. Never checks semantic
 * correctness: no property-assertion mechanism exists yet (design.md §6's
 * "∀ p . ..." properties), only "did this crash or come back garbage."
 */

import { assertPayload } from "./membrane.js";
import { looksLikeFailed } from "./runtime.js";
import type { AnyEdgeDef, OutputSpec } from "./types.js";

/**
 * A bare `many`-output result is a keyed collection standing alone
 * (Record<string, PayloadOf<E>>, types.ts's OutputResult) — not a single
 * edge payload assertPayload can check directly, and not the same shape
 * as a `many` *field* nested inside another edge either (assertPayload's
 * own many-field branch expects an enclosing field to nest under). This
 * runs the same per-entry check — assert each entry against the edge,
 * confirm its own declared index field matches the key it's stored
 * under — adapted for a collection with no enclosing field.
 */
function assertManyOutput(edge: AnyEdgeDef, result: unknown): void {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`many output "${edge.name}": expected a collection object, got ${typeof result}.`);
  }
  if (edge.index === undefined) {
    throw new Error(`many output "${edge.name}": declares no index — a collection needs a real key.`);
  }
  const record = result as Record<string, unknown>;
  const errors: string[] = [];
  for (const [entryKey, entryValue] of Object.entries(record)) {
    try {
      const validated = assertPayload(edge, entryValue) as Record<string, unknown>;
      const actualKey = validated[edge.index];
      if (String(actualKey) !== entryKey) {
        errors.push(`["${entryKey}"]: keyed by "${entryKey}" but its own "${edge.index}" is "${String(actualKey)}"`);
      }
    } catch (cause) {
      errors.push(`["${entryKey}"]: ${(cause as Error).message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`many output "${edge.name}": ${errors.join("; ")}.`);
  }
}

function checkOutput(output: OutputSpec, result: unknown): void {
  if (output.kind === "single") {
    assertPayload(output.edge, result);
    return;
  }

  if (output.kind === "many") {
    assertManyOutput(output.edge, result);
    return;
  }

  if (output.kind === "oneOf") {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error(`oneOf output: expected a { edge, payload } object, got ${typeof result}.`);
    }
    const tagged = result as { edge?: unknown; payload?: unknown };
    const matchedEdge = output.edges.find((edge) => edge.name === tagged.edge);
    if (matchedEdge === undefined) {
      throw new Error(`oneOf output: "${String(tagged.edge)}" is not one of ${output.edges.map((e) => e.name).join(", ")}.`);
    }
    assertPayload(matchedEdge, tagged.payload);
    return;
  }

  // allOf
  if (!Array.isArray(result) || result.length !== output.edges.length) {
    throw new Error(`allOf output: expected exactly ${output.edges.length} tagged branch(es).`);
  }
  const tags = result as { edge?: unknown; payload?: unknown }[];
  for (const edge of output.edges) {
    const tagged = tags.find((t) => t.edge === edge.name);
    if (tagged === undefined) {
      throw new Error(`allOf output: missing a tagged branch for "${edge.name}".`);
    }
    assertPayload(edge, tagged.payload);
  }
}

/** Whether `result` structurally satisfies `output`'s declared shape — never throws. */
export function resultMatchesOutput(output: OutputSpec, result: unknown): boolean {
  try {
    checkOutput(output, result);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `result` is a legitimate outcome for a node fuzzed against
 * `output` — either a real OutputSpec match, or Failed<In>'s shape
 * (always legitimate: design.md's "every node's real output signature is
 * one of {successes, Failed}").
 */
export function isAcceptableResult(output: OutputSpec, result: unknown): boolean {
  return resultMatchesOutput(output, result) || looksLikeFailed(result);
}
```

- [ ] **Step 5: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including every test added in prior tasks.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/fuzz.ts spikes/ts-prototype/src/fuzz.test.ts
git commit -m "Add fuzz.ts structural output validation: resultMatchesOutput, isAcceptableResult"
```

---

## Task 4: `fuzzNode`, and `index.ts` exports

**Files:**
- Modify: `spikes/ts-prototype/src/fuzz.ts`
- Test: `spikes/ts-prototype/src/fuzz.test.ts`
- Modify: `spikes/ts-prototype/src/index.ts`

**Interfaces:**
- Consumes: `generateInputCases` (Task 2, `generate.ts`); `isAcceptableResult` (Task 3, this file); `membrane`, `InMemoryLog`, `Log` (`membrane.ts`, already exported, unchanged).
- Produces: `FuzzReport`, `fuzzNode(nodeDef: NodeDef, opts?: { seed?: number; count?: number }): Promise<FuzzReport>` — this plan's last task; nothing later consumes them.

- [ ] **Step 1: Write the failing tests**

Append to `spikes/ts-prototype/src/fuzz.test.ts` (add to the existing imports, then the new `describe` block):

```ts
// Add to the existing import from "./fuzz.js":
import { fuzzNode, isAcceptableResult, resultMatchesOutput } from "./fuzz.js";
// Add to the existing import from "./define.js":
import { allOf, defineEdge, defineField, defineNode, single } from "./define.js";

describe("fuzzNode", () => {
  it("reports passed === total for a correct single-input Fn", async () => {
    const birthday = defineNode({
      name: "birthday",
      input: single(Person),
      output: single(Person),
      fn: (payload) => ({ age: payload.age }),
    });
    const report = await fuzzNode(birthday, { count: 20 });
    expect(report.total).toBe(20);
    expect(report.passed).toBe(20);
    expect(report.failures).toEqual([]);
  });

  it("records a failure when Fn returns a result matching neither the output nor Failed<In>", async () => {
    const broken = defineNode({
      name: "broken",
      input: single(Person),
      output: single(Person),
      fn: () => ({ garbage: true }) as unknown as { age: number },
    });
    const report = await fuzzNode(broken, { count: 5 });
    expect(report.passed).toBe(0);
    expect(report.failures).toHaveLength(5);
    expect(report.failures[0]).toHaveProperty("input");
    expect(typeof report.failures[0].error).toBe("string");
  });

  it("does not count a deliberate Failed<In> return, or a thrown Fn, as a failure", async () => {
    const sometimesFails = defineNode({
      name: "sometimesFails",
      input: single(Person),
      output: single(Person),
      fn: (payload) => {
        if (payload.age % 2 === 0) throw new Error("even ages are unlucky");
        return { input: payload, reason: "manual rejection" };
      },
    });
    const report = await fuzzNode(sometimesFails, { count: 20 });
    expect(report.passed).toBe(20);
    expect(report.failures).toEqual([]);
  });

  it("fuzzes an allOf-input node correctly via the InMemoryLog path", async () => {
    const Pet = defineEdge({
      name: "Pet",
      label: "Pet",
      description: "A second, unrelated edge for a real allOf combination",
      fields: {
        species: defineField({ type: "utf8", label: "Species", description: "d", nullable: false }),
      },
    });
    // fn ignores its payload on purpose: with Person and Pet's field shapes
    // genuinely different, InputPayload's allOf mapping (types.ts) can't
    // give TS a literal-keyed `.Person`/`.Pet` split when neither edge's
    // own `name` is a literal type (EdgeDef.name is plain `string`) — this
    // test's job is checking fuzzNode's InMemoryLog/allOf wiring, not Fn's
    // own bag-reading, which membrane.test.ts's "allOf" suite already
    // covers directly.
    const combine = defineNode({
      name: "combine",
      input: allOf(Person, Pet),
      output: single(Person),
      fn: () => ({ age: 1 }),
    });
    const report = await fuzzNode(combine, { count: 10 });
    expect(report.total).toBe(10);
    expect(report.passed).toBe(10);
    expect(report.failures).toEqual([]);
  });

  it("defaults to count: 100 when opts are omitted", async () => {
    const alwaysPasses = defineNode({
      name: "alwaysPasses",
      input: single(Person),
      output: single(Person),
      fn: (payload) => payload,
    });
    const report = await fuzzNode(alwaysPasses);
    expect(report.total).toBe(100);
  });
});
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run fuzz.test.ts`
Expected: `fuzzNode` not exported — fails to collect/typecheck.

- [ ] **Step 3: Implement `fuzzNode`**

Append to `spikes/ts-prototype/src/fuzz.ts` (and add the new imports to the top of the file, alongside the existing ones):

```ts
import { InMemoryLog, membrane } from "./membrane.js";
import { generateInputCases } from "./generate.js";
import type { Log } from "./membrane.js";
import type { NodeDef } from "./types.js";

export interface FuzzReport {
  total: number;
  passed: number;
  failures: { input: unknown; error: string }[];
}

const DEFAULT_SEED = 42;
const DEFAULT_COUNT = 100;

/**
 * Same documented cast idiom runtime.ts's own AnySingleInvoke/AnyAllOfInvoke
 * use (and the same plain, doubly-defaulted `NodeDef` runtime.ts's own
 * `program.nodes: Record<string, NodeDef>` already stores its erased node
 * declarations as): membrane()'s return type is a conditional on NodeDef's
 * generic In, which TS can't resolve here even after nodeDef.input.kind is
 * checked at the value level — a real TS narrowing limitation, not a
 * genuine call-shape ambiguity (the `kind` branch itself checks it at
 * runtime).
 */
type AnySingleInvoke = (payload: unknown, correlationId: string) => Promise<unknown>;
type AnyAllOfInvoke = (correlationId: string, log: Log) => Promise<unknown>;

/**
 * Runs `count` generated inputs through `nodeDef`'s real Fn, via
 * membrane() — the same boundary a node actually runs behind in the
 * runtime, reused rather than reimplemented. A generated case's result is
 * a failure only if it matches neither the declared OutputSpec nor
 * Failed<In> (isAcceptableResult); a deliberate Failed<In> return, or a
 * caught Fn throw (membrane() converts every throw to Failed<In> — never
 * lets one escape), are both legitimate, never reported as failures.
 */
export async function fuzzNode(
  nodeDef: NodeDef,
  opts?: { seed?: number; count?: number },
): Promise<FuzzReport> {
  const seed = opts?.seed ?? DEFAULT_SEED;
  const count = opts?.count ?? DEFAULT_COUNT;
  const cases = generateInputCases(nodeDef.input, seed, count);

  const failures: FuzzReport["failures"] = [];
  let passed = 0;

  if (nodeDef.input.kind === "single") {
    const invoke = membrane(nodeDef) as AnySingleInvoke;
    for (const [i, input] of cases.entries()) {
      const result = await invoke(input, `fuzz-${i}`);
      if (isAcceptableResult(nodeDef.output, result)) {
        passed += 1;
      } else {
        failures.push({ input, error: `result matched neither the declared output nor Failed<In>: ${JSON.stringify(result)}` });
      }
    }
  } else {
    const invoke = membrane(nodeDef) as AnyAllOfInvoke;
    for (const [i, bagCase] of cases.entries()) {
      const correlationId = `fuzz-${i}`;
      const log = new InMemoryLog();
      const bag = bagCase as Record<string, unknown>;
      for (const edge of nodeDef.input.edges) {
        log.append(edge.name, correlationId, bag[edge.name]);
      }
      const result = await invoke(correlationId, log);
      if (isAcceptableResult(nodeDef.output, result)) {
        passed += 1;
      } else {
        failures.push({ input: bagCase, error: `result matched neither the declared output nor Failed<In>: ${JSON.stringify(result)}` });
      }
    }
  }

  return { total: count, passed, failures };
}
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Export public symbols from `index.ts`**

```ts
// index.ts, before (end of file):
export { computeImplementationMetadata } from "./metadata.js";
export type { ImplementationMetadata } from "./metadata.js";

// after:
export { computeImplementationMetadata } from "./metadata.js";
export type { ImplementationMetadata } from "./metadata.js";

export { generateInputCases, generatePayload } from "./generate.js";

export { fuzzNode } from "./fuzz.js";
export type { FuzzReport } from "./fuzz.js";
```

- [ ] **Step 6: Run the full suite and typecheck one final time**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src/fuzz.ts spikes/ts-prototype/src/fuzz.test.ts spikes/ts-prototype/src/index.ts
git commit -m "Add fuzzNode: structural fuzz harness over generated cases, export from index.ts"
```
