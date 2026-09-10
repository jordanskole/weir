# `fixed`/`pin` Implementation Plan

> **PAUSED — do not execute without re-confirming first.** Same-day reconsideration chose to try spread-built edge variants for `CreateTodo` first (`docs/design-history.md`, "`pin` reconsidered, same day"). This plan (and its spec, `docs/superpowers/specs/2026-09-09-fixed-pin-node-defaults.md`) stays as a fallback design, not the current direction.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `.node`'s `closure` key to `fixed` (pure rename, no behavior change to its existing `expected`/`literal` shapes), then add a third `fixed` shape, `pin`, that lets a node declare some of its input edge's fields as node-supplied rather than caller-supplied — closing the "partial input, partial node-pinned default" open question and letting `CreateTodo.node` stop requiring its caller to pass `is_complete`.

**Architecture:** `fixed` stays a `oneOf`-discriminated union at the JSON-Schema level (`nodeSchema()`) and a TS union at the type level (`types.ts`), same shape discipline `closure` already had — presence of `expected`/`literal`/`pin` as a key is the discriminant, never a separate tag field. `pin`'s value (`Partial<InputPayload<In>>`, single-kind input only) is declarative only: it does not change `Fn`'s TypeScript signature, and nothing in `elaborate.ts`/`hash.ts`/`netlist.ts` interprets it beyond passing it through — identical treatment to how `expected`/`literal` already flow through those three files today.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest, `npm run typecheck` (`tsc --noEmit`).

**Spec:** `docs/superpowers/specs/2026-09-09-fixed-pin-node-defaults.md` — this plan implements it in full. Read its Motivation and Design sections before Task 1; they explain *why*, this plan only covers *how*. Note its follow-up correction (same file, "Caller-facing intent, not a schema-enforced one"): `pin` is validated only for its own shape, never cross-checked against `given`/`expect`/the input edge's real fields — that's out of scope here, matching `expected`/`literal`'s existing (lack of) enforcement.

**Already done** (commits `304ca1b`, `c4557bc`, prior to this plan): `docs/design.md`, `docs/design-history.md`, `docs/open-questions.md` are already updated — no doc-only task below. This plan covers code only: `spikes/ts-prototype/src/*.ts` + their tests, `schemas/node.schema.json`, and the example fixtures under `examples/`.

## Global Constraints

- All source work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- Follow TDD: write/modify the test first, confirm it fails for the right reason, then write the minimal implementation change, then confirm it passes.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's own convention — see memory `feedback_no_coauthor_trailer`).
- Commit after each task, one task per commit.
- This is a personal project with a work-hours commit convention: if the real time falls inside 9am–5pm on a weekday when you commit, shift the commit's timestamp outside that window using `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible time the same day, rather than committing with the real in-hours timestamp. Check `date` before each commit.
- Regenerate `schemas/node.schema.json` (`npm run generate:schemas` from `spikes/ts-prototype/`) any time `schema.ts` changes, and check the diff.

---

## Task 1: Generalize the `literal` field-kind's value type past booleans

**Files:**
- Modify: `spikes/ts-prototype/src/schema.ts:163-182` (`literalFieldShape()`)
- Test: `spikes/ts-prototype/src/schema.test.ts:178-212` (`describe("fieldSchema", ...)`'s literal tests)
- Test: `spikes/ts-prototype/src/schema.test.ts:296-317` (`describe("edgeSchema", ...)`'s inline-literal tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: a `.field`/`.edge` file's `literal:` value may now be `boolean | string | number` (previously boolean-only). The **bare-boolean sugar** for a literal field (`is_complete: true` directly, without the `literal:` wrapper) stays boolean-only — do not add bare-string or bare-number sugar; a bare string in an edge's `fields` map already means "reference to a `.field`/`.edge` file" (`edgeSchema()`'s `{ type: "string", minLength: 1 }` alternative), so a bare string can never safely become literal-string sugar. Only the explicit `{ literal: ... }` object form widens.

- [ ] **Step 1: Widen the existing "rejects a non-boolean literal value" test, and add acceptance tests for string and number**

In `schema.test.ts`, replace the test at line 208-212:

```ts
// Before:
  it("rejects a non-boolean literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: "done" });
    expect(valid).toBe(false);
  });

// After:
  it("accepts a string literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: "normal", label: "Priority", description: "Always normal" });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a number literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: 3, label: "Retries", description: "Always three" });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a non-scalar literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: { nested: true } });
    expect(valid).toBe(false);
  });

  it("rejects a null literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: null });
    expect(valid).toBe(false);
  });
```

Also add, after the existing `it("accepts an explicit literal field value with a label and description", ...)` block ending at line 307 in the `edgeSchema` describe block:

```ts
  it("accepts an explicit string literal field value inline on an edge", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "CreateTodo input",
      description: "d",
      fields: {
        priority: { literal: "normal", label: "Priority", description: "Always normal" },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
```

- [ ] **Step 2: Run the suite, confirm the new/changed tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run schema.test.ts`
Expected: the two new "accepts a string/number literal value" tests FAIL (schema currently rejects non-boolean `literal`), the new "accepts an explicit string literal field value inline on an edge" test FAILs the same way, "rejects a non-scalar literal value" and "rejects a null literal value" PASS already (both were already rejected, just for the wrong specific reason — booleans-only, not scalars-only — which is fine, this test only checks the outcome).

- [ ] **Step 3: Widen `literalFieldShape()`**

```ts
// schema.ts:163-182, before:
/**
 * A field pinned to a single boolean value, for spread-with-override
 * (`edge CompletedTodo { ...Todo, is_complete: true }`) — a distinct field
 * kind, not a `bool` with a value attached: never `nullable`, never
 * `validations`, both meaningless on a fixed constant. Standalone, parallel
 * to `.node`'s existing `literal:`/`expected:` closure split, rather than a
 * modifier on `type: bool`.
 */
function literalFieldShape(): object {
  return {
    type: "object",
    required: ["literal"],
    properties: {
      literal: { type: "boolean" },
      label: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  };
}

// after:
/**
 * A field pinned to a single scalar value, for spread-with-override
 * (`edge CompletedTodo { ...Todo, is_complete: true }`) — a distinct field
 * kind, not a typed field with a value attached: never `nullable`, never
 * `validations`, both meaningless on a fixed constant. Standalone, parallel
 * to `.node`'s existing `literal:`/`expected:`/`pin:` `fixed` split, rather
 * than a modifier on `type:`. Scalar-only (bool/string/number) — no
 * nested-edge or `many` literal, matching `fixed.pin`'s own scope
 * (docs/superpowers/specs/2026-09-09-fixed-pin-node-defaults.md). Bare-value
 * sugar (`is_complete: true` with no `literal:` wrapper, in `edgeSchema()`)
 * stays boolean-only: a bare string already means "reference to a
 * `.field`/`.edge` file" there, so it can never become literal-string sugar.
 */
function literalFieldShape(): object {
  return {
    type: "object",
    required: ["literal"],
    properties: {
      literal: { type: ["boolean", "string", "number"] },
      label: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  };
}
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run schema.test.ts`
Expected: all tests PASS, including the ones added in Step 1.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Regenerate schemas and commit**

```bash
cd spikes/ts-prototype && npm run generate:schemas
git add spikes/ts-prototype/src/schema.ts spikes/ts-prototype/src/schema.test.ts schemas/field.schema.json schemas/edge.schema.json
git commit -m "Generalize the literal field kind past booleans to string/number"
```

---

## Task 2: Rename `closure` to `fixed`, no behavior change

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts:356-384` (`NodeDef.closure`, `ExpectClosure`, `LiteralClosure`)
- Modify: `spikes/ts-prototype/src/schema.ts:248-256,378-393` (`nodeSchema()`'s doc comment and `closure` property)
- Modify: `spikes/ts-prototype/src/elaborate.ts:1-9,229-246,277-302` (module doc comment, both destructures/passthroughs)
- Modify: `spikes/ts-prototype/src/hash.ts:133-186` (`NodeFingerprint`, `fingerprintNode`)
- Modify: `spikes/ts-prototype/src/netlist.ts:29-38,95-107` (`NetlistNode`, `serializeNode`)
- Modify: `spikes/ts-prototype/src/schema.test.ts:595-641` (the four `closure` tests)
- Modify: `spikes/ts-prototype/src/hash.test.ts:374-384`
- Modify: `spikes/ts-prototype/src/node.test.ts:107-160`
- Modify: `spikes/ts-prototype/src/netlist.test.ts:151-179`
- Modify: `examples/person-birthday/netlist.json`
- Modify: `examples/person-birthday/src/nodes/expect_Person_age_42.node`
- Modify: `examples/person-birthday/README.md`, `examples/recipe/README.md` (prose only)
- Modify: `schemas/node.schema.json` (regenerated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `NodeDef.fixed?: ExpectFixed<In> | LiteralFixed<O>` (the `PinFixed` member is added in Task 3, not here — keep this task a pure rename with zero new shapes, so it can't be confused with Task 3's behavior addition if reviewed separately). `NodeDecl["fixed"]`, `NodeFingerprint.fixed`, `NetlistNode.fixed` all follow.

This task is a mechanical, repo-wide identifier rename with no intermediate valid state (the codebase won't typecheck between "some files say `closure`, some say `fixed`") — do it as a single pass across all files, then verify once, rather than TDD-ing file by file.

- [ ] **Step 1: Rename in `types.ts`**

```ts
// types.ts:369, before:
  closure?: ExpectClosure<In> | LiteralClosure<O>;

// after:
  fixed?: ExpectFixed<In> | LiteralFixed<O>;
```

```ts
// types.ts:383-384, before:
type ExpectClosure<In extends InputSpec> = { expected: InputPayload<In> };
type LiteralClosure<O extends OutputSpec> = { literal: OutputResult<O> };

// after:
type ExpectFixed<In extends InputSpec> = { expected: InputPayload<In> };
type LiteralFixed<O extends OutputSpec> = { literal: OutputResult<O> };
```

Update the doc comment above `closure?` (directly above line 369, the block starting "Parameters baked in at elaboration time") to say `fixed` instead of `closure` wherever it names the property.

- [ ] **Step 2: Rename in `schema.ts`**

```ts
// schema.ts:250-251, before (nodeSchema()'s own doc comment):
 * no `fn`, name/input/output/examples/closure. `input`/`output` reference

// after:
 * no `fn`, name/input/output/examples/fixed. `input`/`output` reference
```

```ts
// schema.ts:378-393, before:
      closure: {
        oneOf: [
          {
            type: "object",
            properties: { expected: taggedOne(objectPayload) },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: tagged({}) },
            required: ["literal"],
            additionalProperties: false,
          },
        ],
      },

// after:
      fixed: {
        oneOf: [
          {
            type: "object",
            properties: { expected: taggedOne(objectPayload) },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: tagged({}) },
            required: ["literal"],
            additionalProperties: false,
          },
        ],
      },
```

(The `literal:`/`expected:` branches themselves are untouched here — `pin`'s branch is added in Task 3.)

Also update line 168's doc comment ("`.node`'s existing `literal:`/`expected:` closure split") to say "`fixed` split".

- [ ] **Step 3: Rename in `elaborate.ts`**

Update the module doc comment (line 5): `` `input`, `output`, `examples`, `closure` — never `fn`, `` → `` `input`, `output`, `examples`, `fixed` — never `fn`, ``.

In both `parseNodeFile` (around line 229) and `parseAnyOfNodeFile` (around line 277):

```ts
// before (appears twice, once per function):
  const { label, description, input, output, examples, closure } = raw as {
    label?: unknown;
    description?: unknown;
    input?: unknown;
    output?: unknown;
    examples?: unknown;
    closure?: unknown;
  };

// after:
  const { label, description, input, output, examples, fixed } = raw as {
    label?: unknown;
    description?: unknown;
    input?: unknown;
    output?: unknown;
    examples?: unknown;
    fixed?: unknown;
  };
```

(`parseAnyOfNodeFile`'s destructure has a narrower `input?: { anyOf: unknown }` type than shown above — keep that field as-is, only rename `closure` → `fixed` within it.)

```ts
// both functions' return/decls construction, before:
    ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),

// after:
    ...(fixed !== undefined && { fixed: fixed as NodeDecl["fixed"] }),
```

- [ ] **Step 4: Rename in `hash.ts`**

```ts
// hash.ts:139, doc comment, before:
 * excluded, same as `EdgeFingerprint`. `closure` is included: a baked-in
 * literal (an `expect` node's expected value, an origin's literal) changes
 * what the implementation must actually compute, even though it doesn't
 * change `input`/`output`'s types.

// after:
 * excluded, same as `EdgeFingerprint`. `fixed` is included: a baked-in
 * literal or pinned default (an `expect` node's expected value, an origin's
 * literal, a node's pinned input field) changes what the implementation
 * must actually compute, even though it doesn't change `input`/`output`'s
 * types.
```

```ts
// hash.ts:152, before:
  closure?: unknown;

// after:
  fixed?: unknown;
```

```ts
// hash.ts:186, before:
    ...(node.closure !== undefined && { closure: node.closure }),

// after:
    ...(node.fixed !== undefined && { fixed: node.fixed }),
```

- [ ] **Step 5: Rename in `netlist.ts`**

```ts
// netlist.ts:36, before:
  closure?: unknown;

// after:
  fixed?: unknown;
```

```ts
// netlist.ts:103, before:
    ...(node.closure !== undefined && { closure: node.closure }),

// after:
    ...(node.fixed !== undefined && { fixed: node.fixed }),
```

- [ ] **Step 6: Rename in every test file**

In `schema.test.ts:595-641`, rename all four tests and their bodies (`closure` → `fixed` as the object key; keep `expected`/`literal` untouched):

```ts
// before:
  it("accepts a closure with a tagged expected", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
      examples: [{ given: { Person: { age: 42 } }, expect: { Pass: {} } }],
      closure: { expected: { Person: { age: 42 } } },
    });
    expect(valid).toBe(true);
  });

  it("accepts a closure with a tagged literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Unit",
      output: "Person",
      examples: [{ given: { Unit: {} }, expect: { Person: { age: 41 } } }],
      closure: { literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(true);
  });

  it("rejects a closure with both expected and literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      closure: { expected: { Person: { age: 41 } }, literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(false);
  });

  it("rejects a closure with neither expected nor literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      closure: {},
    });
    expect(valid).toBe(false);
  });

// after:
  it("accepts a fixed with a tagged expected", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
      examples: [{ given: { Person: { age: 42 } }, expect: { Pass: {} } }],
      fixed: { expected: { Person: { age: 42 } } },
    });
    expect(valid).toBe(true);
  });

  it("accepts a fixed with a tagged literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Unit",
      output: "Person",
      examples: [{ given: { Unit: {} }, expect: { Person: { age: 41 } } }],
      fixed: { literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(true);
  });

  it("rejects a fixed with both expected and literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      fixed: { expected: { Person: { age: 41 } }, literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(false);
  });

  it("rejects a fixed with neither expected nor literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      fixed: {},
    });
    expect(valid).toBe(false);
  });
```

In `hash.test.ts:374-384`, rename the test and its `closure`/`differentClosure` locals:

```ts
// before:
  it("changes when closure differs", async () => {
    const expectNode: NodeDecl = {
      name: "expect_Person_age_42",
      description: "d",
      input: { kind: "single", edge: Person },
      output: { kind: "oneOf", edges: [{ name: "Pass", description: "d", fields: {} }, { name: "Fail", description: "d", fields: {} }] },
      closure: { expected: { age: 42 } },
    };
    const differentClosure: NodeDecl = { ...expectNode, closure: { expected: { age: 43 } } };
    expect((await hashNode(differentClosure)).hash).not.toBe((await hashNode(expectNode)).hash);
  });

// after:
  it("changes when fixed differs", async () => {
    const expectNode: NodeDecl = {
      name: "expect_Person_age_42",
      description: "d",
      input: { kind: "single", edge: Person },
      output: { kind: "oneOf", edges: [{ name: "Pass", description: "d", fields: {} }, { name: "Fail", description: "d", fields: {} }] },
      fixed: { expected: { age: 42 } },
    };
    const differentFixed: NodeDecl = { ...expectNode, fixed: { expected: { age: 43 } } };
    expect((await hashNode(differentFixed)).hash).not.toBe((await hashNode(expectNode)).hash);
  });
```

In `node.test.ts`, rename the three `closure:` keys at lines 114, 139, 155 to `fixed:` (values unchanged: `{ literal: { age: 42 } }`, `{ expected: { age: 42 } }`, `{ literal: { age: 41 } }` respectively).

In `netlist.test.ts:151-179`, rename the test and its `closure:` keys:

```ts
// before:
  it("includes label/description/closure/examples/scope only when present", async () => {
    const bare = defineNode({ name: "bare", input: single(Person), output: single(Person), fn: (p) => p });
    const rich = defineNode({
      name: "rich",
      label: "Rich",
      description: "Has everything",
      input: single(Person),
      output: single(Person),
      closure: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
      fn: (p) => p,
    });

    const netlist = await serializeNetlist(
      elaborated({ edges: { Person }, nodes: { bare, rich } }),
    );

    expect(netlist.nodes.bare).toStrictEqual({ input: "Person", output: "Person" });
    expect(netlist.nodes.rich).toStrictEqual({
      input: "Person",
      output: "Person",
      label: "Rich",
      description: "Has everything",
      closure: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
    });
  });

// after:
  it("includes label/description/fixed/examples/scope only when present", async () => {
    const bare = defineNode({ name: "bare", input: single(Person), output: single(Person), fn: (p) => p });
    const rich = defineNode({
      name: "rich",
      label: "Rich",
      description: "Has everything",
      input: single(Person),
      output: single(Person),
      fixed: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
      fn: (p) => p,
    });

    const netlist = await serializeNetlist(
      elaborated({ edges: { Person }, nodes: { bare, rich } }),
    );

    expect(netlist.nodes.bare).toStrictEqual({ input: "Person", output: "Person" });
    expect(netlist.nodes.rich).toStrictEqual({
      input: "Person",
      output: "Person",
      label: "Rich",
      description: "Has everything",
      fixed: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
    });
  });
```

- [ ] **Step 7: Rename in the example fixtures**

In `examples/person-birthday/src/nodes/expect_Person_age_42.node`, rename the trailing key:

```yaml
# before:
closure:
  expected:
    Person:
      age: 42

# after:
fixed:
  expected:
    Person:
      age: 42
```

In `examples/person-birthday/netlist.json`, rename both occurrences (values unchanged):

```json
// before:
      "closure": { "literal": { "age": 41 } }
// after:
      "fixed": { "literal": { "age": 41 } }
```

```json
// before:
      "closure": { "expected": { "age": 42 } }
// after:
      "fixed": { "expected": { "age": 42 } }
```

In `examples/person-birthday/README.md` and `examples/recipe/README.md`, replace prose occurrences of "closure"/"closure-literal"/"closure-origin"/"closure:" with "fixed"/"fixed-literal"/"fixed-origin"/"fixed:" (read each surrounding sentence before replacing — these are prose, not code, so match voice rather than doing a blind find-replace).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

Run: `grep -rn "closure" spikes/ts-prototype/src examples/person-birthday examples/recipe docs/design.md` (from repo root)
Expected: no output — confirms nothing was missed. (`docs/design-history.md`'s historical entries and `docs/superpowers/plans/2026-08-31-oneof-desugaring-and-allof-rename.md` are expected to still mention "closure" — they're historical record, not live documentation; don't touch them.)

- [ ] **Step 9: Regenerate schemas and commit**

```bash
cd spikes/ts-prototype && npm run generate:schemas
git add spikes/ts-prototype schemas/node.schema.json examples/person-birthday examples/recipe/README.md
git commit -m "Rename closure to fixed across the codebase, no behavior change"
```

---

## Task 3: Add `fixed.pin`

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts` (add `PinFixed`, widen `NodeDef.fixed`)
- Modify: `spikes/ts-prototype/src/schema.ts` (add `pin` branch to `nodeSchema()`'s `fixed`)
- Test: `spikes/ts-prototype/src/schema.test.ts` (new `pin` tests, alongside the renamed `fixed` tests from Task 2)
- Test: `spikes/ts-prototype/src/node.test.ts` (one new `defineNode` test using `fixed: { pin: ... } }`)

**Interfaces:**
- Consumes: `InputSpec`, `InputPayload<In>` (`types.ts`, unchanged).
- Produces: `NodeDef.fixed?: ExpectFixed<In> | LiteralFixed<O> | PinFixed<In>`; `PinFixed<In extends InputSpec> = In extends { kind: "single" } ? { pin: Partial<InputPayload<In>> } : never`.

- [ ] **Step 1: Write the failing schema tests**

In `schema.test.ts`, add after the (now-renamed) `"rejects a fixed with neither expected nor literal"` test, still inside `describe("nodeSchema", ...)`:

```ts
  it("accepts a fixed with a pin of one scalar field", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Todo",
      output: "Todo",
      examples: [
        { given: { Todo: { id: "todo-1", title: "Buy milk" } }, expect: { Todo: { id: "todo-1", title: "Buy milk", is_complete: false } } },
      ],
      fixed: { pin: { is_complete: false } },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a fixed with a pin of several scalar fields, mixed types", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Todo",
      output: "Todo",
      examples: [{ given: { Todo: {} }, expect: { Todo: {} } }],
      fixed: { pin: { is_complete: false, priority: "normal" } },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a pin with an empty object", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Todo",
      output: "Todo",
      examples: [{ given: { Todo: {} }, expect: { Todo: {} } }],
      fixed: { pin: {} },
    });
    expect(valid).toBe(false);
  });

  it("rejects a pin field value that isn't a scalar", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Todo",
      output: "Todo",
      examples: [{ given: { Todo: {} }, expect: { Todo: {} } }],
      fixed: { pin: { nested: { a: 1 } } },
    });
    expect(valid).toBe(false);
  });

  it("rejects a fixed with both pin and literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Todo",
      output: "Todo",
      examples: [{ given: { Todo: {} }, expect: { Todo: {} } }],
      fixed: { pin: { is_complete: false }, literal: { is_complete: false } },
    });
    expect(valid).toBe(false);
  });
```

The existing `Task` edge (`node.test.ts:56-70`) only has `id`/`title` — no boolean field to pin. Rather than widen that shared fixture (other tests use it as-is), define a small edge inline in the new test, matching this file's existing pattern of scoping a one-off edge to the test that needs it (see `"types an allOf node..."`'s inline `OrderPlaced`/`InvoiceRequested`, `node.test.ts:163-169`).

In `node.test.ts`, add after the `"types an origin node against Unit instead of null input"` test (around line 160):

```ts
  it("types a node with fixed.pin narrowing which input fields the caller supplies", () => {
    const CreatableTask = defineEdge({
      name: "CreatableTask",
      label: "Creatable task",
      description: "A task, as created — is_complete always starts false",
      index: "id",
      fields: {
        id: defineField({ type: "utf8", label: "ID", description: "The task's id", nullable: false }),
        title: defineField({ type: "utf8", label: "Title", description: "The task's title", nullable: false }),
        is_complete: defineField({ type: "bool", label: "Is Complete", description: "Whether the task is done" }),
      },
    });

    const createTask = defineNode({
      name: "CreateTask",
      input: single(CreatableTask),
      output: single(CreatableTask),
      fixed: { pin: { is_complete: false } },
      fn: (task) => ({ ...task, is_complete: false }),
    });

    expect(createTask.fn({ id: "t1", title: "Buy milk", is_complete: false })).toEqual({
      id: "t1",
      title: "Buy milk",
      is_complete: false,
    });
  });
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: the six new tests FAIL — the schema tests because `nodeSchema()` doesn't yet recognize a `pin` key under `fixed` (falls through to "rejects" for the accept-cases, or the reject-cases pass vacuously for the wrong reason — check each manually); the `node.test.ts` test fails to typecheck (`fixed: { pin: ... } }` isn't assignable to `NodeDef["fixed"]` yet), which `npm run typecheck` will also surface.

- [ ] **Step 3: Add `PinFixed` to `types.ts`**

```ts
// types.ts, after the existing ExpectFixed/LiteralFixed type aliases (renamed in Task 2):
type ExpectFixed<In extends InputSpec> = { expected: InputPayload<In> };
type LiteralFixed<O extends OutputSpec> = { literal: OutputResult<O> };
type PinFixed<In extends InputSpec> = In extends { kind: "single" } ? { pin: Partial<InputPayload<In>> } : never;
```

```ts
// NodeDef.fixed, before (post-Task-2):
  fixed?: ExpectFixed<In> | LiteralFixed<O>;

// after:
  fixed?: ExpectFixed<In> | LiteralFixed<O> | PinFixed<In>;
```

Update the doc comment above `fixed?` to add one sentence: "`pin` bakes in *some* of an ordinary node's input fields — the node supplies them, the caller doesn't — rather than a whole input/output (docs/superpowers/specs/2026-09-09-fixed-pin-node-defaults.md)."

- [ ] **Step 4: Add the `pin` branch to `nodeSchema()`'s `fixed`**

```ts
// schema.ts, fixed's oneOf array, before (post-Task-2):
      fixed: {
        oneOf: [
          {
            type: "object",
            properties: { expected: taggedOne(objectPayload) },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: tagged({}) },
            required: ["literal"],
            additionalProperties: false,
          },
        ],
      },

// after:
      fixed: {
        oneOf: [
          {
            type: "object",
            properties: { expected: taggedOne(objectPayload) },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: tagged({}) },
            required: ["literal"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              pin: {
                type: "object",
                minProperties: 1,
                additionalProperties: { type: ["boolean", "string", "number"] },
              },
            },
            required: ["pin"],
            additionalProperties: false,
          },
        ],
      },
```

- [ ] **Step 5: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including the six added in Step 1.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Regenerate schemas and commit**

```bash
cd spikes/ts-prototype && npm run generate:schemas
git add spikes/ts-prototype/src/types.ts spikes/ts-prototype/src/schema.ts spikes/ts-prototype/src/schema.test.ts spikes/ts-prototype/src/node.test.ts schemas/node.schema.json
git commit -m "Add fixed.pin: node-scoped partial input defaults"
```

---

## Task 4: Rewrite `CreateTodo.node` to use `fixed.pin`

**Files:**
- Modify: `examples/todo-list/src/nodes/CreateTodo.node`

**Interfaces:**
- Consumes: `fixed.pin` (Task 3).
- Produces: nothing consumed by a later task — this is the plan's last task.

This is a fixture-only change validated by `nodeSchema()` (Task 3) and, indirectly, by `runtime.test.ts`'s existing "runs the real todo-list topology" test (`spikes/ts-prototype/src/runtime.test.ts:419`), which loads `examples/todo-list/src/` from disk via `elaborate()`. That test constructs its own invocation payload by hand (`{ CreateTodo: todo }`, `todo` including `is_complete: false`) rather than reading `CreateTodo.node`'s `examples:` block, so it keeps passing unchanged regardless of this edit — confirm that in Step 2, don't assume it.

- [ ] **Step 1: Rewrite the file**

```yaml
# examples/todo-list/src/nodes/CreateTodo.node, before:
label: Create Todo
description: Creates a new task
input: Todo
output: Todo
examples:
  - given:
      Todo:
        id: "todo-1"
        title: "Buy milk and eggs"
        description: "Get 2% milk from the store"
        is_complete: false
    expect:
      Todo:
        id: "todo-1"
        title: "Buy milk and eggs"
        description: "Get 2% milk from the store"
        is_complete: false

# after:
label: Create Todo
description: Creates a new task
input: Todo
output: Todo
fixed:
  pin:
    is_complete: false
examples:
  - given:
      Todo:
        id: "todo-1"
        title: "Buy milk and eggs"
        description: "Get 2% milk from the store"
    expect:
      Todo:
        id: "todo-1"
        title: "Buy milk and eggs"
        description: "Get 2% milk from the store"
        is_complete: false
```

- [ ] **Step 2: Confirm the full suite still passes, including the disk-loaded todo-list integration test**

Run: `cd spikes/ts-prototype && npx vitest run runtime.test.ts`
Expected: PASS, including `"runs the real todo-list topology — CompleteTodo fires from CreateTodo's output; AddTodoToList never becomes ready"` — this test calls `elaborate(TODO_LIST_SRC)`, which reads `CreateTodo.node` off disk, so it's the one existing test that actually parses the file you just changed. If it fails, read the error before changing anything else — `TODO_LIST_SRC`'s loader might do more field validation than `elaborate.ts`'s `parseNodeFile` did when last inspected for this plan; don't assume the plan's earlier findings still hold without checking.

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add examples/todo-list/src/nodes/CreateTodo.node
git commit -m "CreateTodo: pin is_complete rather than requiring it from the caller"
```
