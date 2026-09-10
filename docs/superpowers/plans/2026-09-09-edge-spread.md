# Edge Spread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `...Name` edge spread (`.edge` files copying another edge's fields, with local overrides) — decided in `design.md` §2 long ago, never implemented. Along the way, wire up the `literal` field kind end-to-end (also decided, also never implemented beyond `schema.ts`'s YAML validation), since the plan's own motivating example (`Cookies.edge` pinning `done` to always-`true`) depends on it being real. Land on the actual `examples/recipe` fixtures, replacing their hand-duplicated `title`/`servings` fields with a real spread chain (`Dough` → `BakedCookies` → `Cookies`).

**Architecture:** Spread is resolved once, at `.edge`-parsing time, inside `elaborate.ts`'s `parseEdgeFile` — a `...Name` key in `fields:` is expanded into its source edge's own `fields`, then every other locally-declared key overwrites same-named entries whole-value. Nothing downstream (`hash.ts`, `netlist.ts`, `membrane.ts`, a node's `Fn`) ever knows spread was involved — the result is an ordinary, fully-expanded `EdgeDef`, same as one typed out by hand. The `literal` field kind gets a real `LiteralFieldDef` type (`types.ts`), recognized by `parseEdgeFile` (bare-boolean sugar and the explicit `{ literal: ... }` object form), and handled by `hash.ts`'s fingerprinting (it currently assumes every scalar field has a `.type`, which a literal field doesn't — a real, previously-silent bug this plan fixes as a side effect). The TS-level `defineEdge` API needs no spread-specific code at all: plain JS/TS object spread (`{ ...Dough.fields, done: ... }`) already does the job natively.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest, `npm run typecheck` (`tsc --noEmit`).

**Spec:** `docs/superpowers/specs/2026-09-09-edge-spread.md` — this plan implements it in full, plus the literal-field-kind wiring the spec's own recipe example depends on (agreed as in-scope for this plan, not a separate spec — see the spec's "Explicitly out of scope" note on generalizing `literal`, which is a different, still-out-of-scope concern: booleans-only wiring, not widening to string/number).

## Global Constraints

- All source work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- Follow TDD: write/modify the test first, confirm it fails for the right reason, then write the minimal implementation change, then confirm it passes.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's own convention).
- Commit after each task, one task per commit.
- This is a personal project with a work-hours commit convention: if the real time falls inside 9am–5pm on a weekday when you commit, shift the commit's timestamp outside that window using `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible time the same day, rather than committing with the real in-hours timestamp. Check `date` before each commit.
- Regenerate `schemas/*.json` (`npm run generate:schemas` from `spikes/ts-prototype/`) any time `schema.ts` changes, and check the diff.

---

## Task 1: Wire up the `literal` field kind (types, parsing, hashing)

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts` (`LiteralFieldDef`, `EdgeDef`, `AnyEdgeDef`, `Payload`)
- Modify: `spikes/ts-prototype/src/define.ts` (new `defineLiteral` helper)
- Modify: `spikes/ts-prototype/src/elaborate.ts:122-161` (`parseEdgeFile`)
- Modify: `spikes/ts-prototype/src/hash.ts:26-40,55-` (`ScalarFieldFingerprint`/`FieldFingerprint`, `fingerprint`)
- Modify: `spikes/ts-prototype/src/netlist.ts:21,61-65` (`NetlistField`, `serializeField`)
- Test: `spikes/ts-prototype/src/elaborate.test.ts` (new `parseEdgeFile` tests)
- Test: `spikes/ts-prototype/src/hash.test.ts` (new fingerprint test)
- Test: `spikes/ts-prototype/src/netlist.test.ts` (new serialize test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LiteralFieldDef = { literal: boolean; label?: string; description?: string }` (`types.ts`), a new member of `EdgeDef`'s field-value union alongside `FieldDef | AnyEdgeDef | ManyEdgeDef`. `Payload<F>` maps a `LiteralFieldDef` field to plain `boolean` (not narrowed to its specific literal value — nothing in this codebase currently needs that precision, and it would require the same generic-inference trick `FieldDef<T,N>` uses, which isn't worth the complexity here). `defineLiteral(def: LiteralFieldDef): LiteralFieldDef` — identity helper, TS-authoring-side, mirroring `defineField`/`defineEdge`/`defineNode`'s existing "define + return unchanged" shape.

- [ ] **Step 1: Write the failing `parseEdgeFile` tests**

In `elaborate.test.ts`, add inside `describe("parseEdgeFile", ...)`, after the existing `"rejects a many: reference that resolves to a field, not an edge"` test:

```ts
  it("resolves a bare-boolean field value into a LiteralFieldDef", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  is_complete: true
`;
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(edge.fields.is_complete).toEqual({ literal: true });
  });

  it("resolves an explicit { literal } field value, label and description included", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  is_complete:
    literal: true
    label: Is Complete
    description: Always true on a CompletedTodo
`;
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(edge.fields.is_complete).toEqual({
      literal: true,
      label: "Is Complete",
      description: "Always true on a CompletedTodo",
    });
  });
```

In `hash.test.ts`, add inside `describe("hashEdge", ...)`, as its last test, right before that `describe` block's closing `});` (after `it("produces distinct hashes for a field without optional fingerprint keys vs with them", ...)`, line 295) — matching the file's existing bare-`EdgeDef`-literal fixture style (e.g. `base`, defined at the top of the file — no `defineEdge()` wrapper needed):

```ts
  it("fingerprints a literal field as { literal }, not a scalar type", async () => {
    const edgeWithLiteral: AnyEdgeDef = {
      name: "CompletedTodo",
      label: "CompletedTodo",
      description: "d",
      fields: { is_complete: { literal: true } },
    };
    const { hash } = await hashEdge(edgeWithLiteral);
    expect(hash).toBeTruthy();
    const edgeWithDifferentLiteral: AnyEdgeDef = {
      ...edgeWithLiteral,
      fields: { is_complete: { literal: false } },
    };
    expect((await hashEdge(edgeWithDifferentLiteral)).hash).not.toBe(hash);
  });
```

(Check `hash.test.ts`'s actual imports/existing fixture style before inserting — match whatever pattern its other `hashEdge` tests already use for constructing a bare `AnyEdgeDef` literal, rather than assuming the shape above is exactly right if the file does it differently.)

In `netlist.test.ts`, add inside `describe("serializeNetlist — edges", ...)` (starts at line 62), after its first test (`"serializes a scalar-only edge's fields verbatim, plus its schemaHash"`) — using the file's own `elaborated(overrides: Partial<Elaborated>): Elaborated` local helper (defined at line 58: `{ fields: {}, edges: {}, nodes: {}, wiring: { origins: [], feeds: {} }, ...overrides }` — only `edges` needs overriding here):

```ts
  it("serializes a literal field verbatim, same shape it was declared with", async () => {
    const CompletedTodo = defineEdge({
      name: "CompletedTodo",
      label: "CompletedTodo",
      description: "d",
      fields: { is_complete: { literal: true } },
    });
    const netlist = await serializeNetlist(elaborated({ edges: { CompletedTodo } }));
    expect(netlist.edges.CompletedTodo!.fields.is_complete).toEqual({ literal: true });
  });
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: the `elaborate.test.ts` tests FAIL (`parseEdgeFile` doesn't recognize bare booleans or `{ literal }` objects yet — they fall through to the generic `else` branch, producing a wrong/garbage `FieldDef`-shaped result). The `hash.test.ts`/`netlist.test.ts` tests likely fail to even typecheck first (`{ literal: true }` isn't assignable to `AnyEdgeDef`'s field-value union yet) — `npm run typecheck` will also show this.

- [ ] **Step 3: Add `LiteralFieldDef` to `types.ts`**

```ts
// types.ts, after FieldDef's definition (around line 71), before NumberValidation:
/**
 * A field pinned to a single boolean constant, never caller-suppliable —
 * for spread-with-override (`edge CompletedTodo { ...Todo, is_complete: true }`,
 * docs/superpowers/specs/2026-09-09-edge-spread.md). A distinct field kind, not
 * a `bool` with a value attached: no `nullable`, no `validations`, both
 * meaningless on a fixed constant.
 */
export interface LiteralFieldDef {
  literal: boolean;
  label?: string;
  description?: string;
}
```

```ts
// types.ts:100-109, EdgeDef, before:
export interface EdgeDef<
  F extends Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef> = Record<string, FieldDef>,
> {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: F;
}

// after:
export interface EdgeDef<
  F extends Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = Record<string, FieldDef>,
> {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: F;
}
```

```ts
// types.ts:131, AnyEdgeDef, before:
export type AnyEdgeDef = EdgeDef<Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef>>;

// after:
export type AnyEdgeDef = EdgeDef<Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef>>;
```

```ts
// types.ts:165-175, Payload<F>, before:
export type Payload<F extends Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T, infer N>
    ? N extends true
      ? ScalarTsType<T> | null
      : ScalarTsType<T>
    : F[K] extends ManyEdgeDef<infer E>
      ? Record<string, PayloadOf<E>>
      : F[K] extends AnyEdgeDef
        ? PayloadOf<F[K]>
        : never;
};

// after:
export type Payload<F extends Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T, infer N>
    ? N extends true
      ? ScalarTsType<T> | null
      : ScalarTsType<T>
    : F[K] extends LiteralFieldDef
      ? boolean
      : F[K] extends ManyEdgeDef<infer E>
        ? Record<string, PayloadOf<E>>
        : F[K] extends AnyEdgeDef
          ? PayloadOf<F[K]>
          : never;
};
```

Every other place in `types.ts` that spells out `FieldDef | AnyEdgeDef | ManyEdgeDef` as a bound (check `Payload<F>`'s own generic constraint, already shown above, and scan the file for any other occurrence) needs the same `| LiteralFieldDef` addition — grep the file for `AnyEdgeDef | ManyEdgeDef` and `FieldDef | AnyEdgeDef` after this step to confirm none were missed.

- [ ] **Step 4: Add `defineLiteral` to `define.ts`**

```ts
// define.ts, near defineField (after its closing brace, around line 162):
/** Define a single literal-pinned field. Returns the input unchanged — no runtime validation needed, LiteralFieldDef's TS type already excludes nullable/validations entirely. */
export function defineLiteral(field: LiteralFieldDef): LiteralFieldDef {
  return field;
}
```

Add `LiteralFieldDef` to this file's import from `./types.js`.

- [ ] **Step 5: Recognize literal fields in `parseEdgeFile`**

```ts
// elaborate.ts, inside parseEdgeFile (around line 134-152), before:
  const resolvedFields: Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      requireIndex(resolved, `"${key}.many"`);
      resolvedFields[key] = { many: resolved };
    } else {
      resolvedFields[key] = value as FieldDef;
    }
  }

// after:
  const resolvedFields: Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (typeof value === "boolean") {
      resolvedFields[key] = { literal: value };
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      requireIndex(resolved, `"${key}.many"`);
      resolvedFields[key] = { many: resolved };
    } else if (value !== null && typeof value === "object" && "literal" in value) {
      resolvedFields[key] = value as LiteralFieldDef;
    } else {
      resolvedFields[key] = value as FieldDef;
    }
  }
```

Add `LiteralFieldDef` to this file's import from `./types.js`.

- [ ] **Step 6: Fingerprint literal fields correctly in `hash.ts`**

```ts
// hash.ts:47, FieldFingerprint, before:
type FieldFingerprint = ScalarFieldFingerprint | { edge: EdgeFingerprint } | { many: EdgeFingerprint };

// after:
type FieldFingerprint =
  | ScalarFieldFingerprint
  | { edge: EdgeFingerprint }
  | { many: EdgeFingerprint }
  | { literal: boolean };
```

```ts
// hash.ts, inside fingerprint()'s per-field loop (around line 58-71), before:
  for (const key of Object.keys(edge.fields).sort()) {
    const value = edge.fields[key] as FieldDef | AnyEdgeDef | ManyEdgeDef;

    if ("many" in value) {
      fields[key] = { many: fingerprint(value.many) };
      continue;
    }

    if ("fields" in value) {
      fields[key] = { edge: fingerprint(value) };
      continue;
    }

    const f = value;
    const entry: ScalarFieldFingerprint = { type: f.type };

// after:
  for (const key of Object.keys(edge.fields).sort()) {
    const value = edge.fields[key] as FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef;

    if ("many" in value) {
      fields[key] = { many: fingerprint(value.many) };
      continue;
    }

    if ("fields" in value) {
      fields[key] = { edge: fingerprint(value) };
      continue;
    }

    if ("literal" in value) {
      fields[key] = { literal: value.literal };
      continue;
    }

    const f = value;
    const entry: ScalarFieldFingerprint = { type: f.type };
```

Add `LiteralFieldDef` to this file's import from `./types.js`. This is the fix for the silent bug found while writing this plan: before this change, a literal field's fingerprint entry was `{ type: undefined }` — indistinguishable from a malformed scalar field, and two edges differing only in their literal field's value would silently hash identically (staleness detection would miss the change entirely).

- [ ] **Step 7: Update `netlist.ts`'s types (no logic change needed)**

```ts
// netlist.ts:21, before:
export type NetlistField = FieldDef | { edge: string } | { many: string };

// after:
export type NetlistField = FieldDef | LiteralFieldDef | { edge: string } | { many: string };
```

```ts
// netlist.ts:61, serializeField's parameter type, before:
function serializeField(value: FieldDef | AnyEdgeDef | ManyEdgeDef): NetlistField {

// after:
function serializeField(value: FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef): NetlistField {
```

The function body (`if ("many" in value) ...`, `if ("fields" in value) ...`, `return value`) needs no change — a `LiteralFieldDef` value already falls through the two existing checks and returns verbatim via the final `return value`, which is exactly correct (a literal field serializes to `{ literal: true, ... }` as-is).

Add `LiteralFieldDef` to this file's import from `./types.js`.

- [ ] **Step 8: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including every test added in Step 1.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add spikes/ts-prototype/src/types.ts spikes/ts-prototype/src/define.ts spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/hash.ts spikes/ts-prototype/src/netlist.ts spikes/ts-prototype/src/elaborate.test.ts spikes/ts-prototype/src/hash.test.ts spikes/ts-prototype/src/netlist.test.ts
git commit -m "Wire up the literal field kind: types, parsing, hashing"
```

---

## Task 2: Recognize `...Name` spread keys in `edgeSchema()`

**Files:**
- Modify: `spikes/ts-prototype/src/schema.ts:193-224` (`edgeSchema()`)
- Test: `spikes/ts-prototype/src/schema.test.ts` (new tests in `describe("edgeSchema", ...)`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `edgeSchema()`'s `fields:` object accepts a `...Name:` key (value must be `null`) alongside its four existing field-value shapes, via a new `patternProperties` entry independent of `additionalProperties`.

- [ ] **Step 1: Write the failing tests**

In `schema.test.ts`, add inside `describe("edgeSchema", ...)`, after the existing `"rejects an inline literal field value carrying nullable"` test (around line 317):

```ts
  it("accepts a spread key with a null value", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: {
        "...Dough": null,
        done: { type: "bool", label: "Done", description: "d" },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a spread key with a non-null value", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: { "...Dough": "Dough" },
    });
    expect(valid).toBe(false);
  });

  it("rejects a bare ... spread key naming no source", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: { "...": null },
    });
    expect(valid).toBe(false);
  });
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run schema.test.ts`
Expected: `"accepts a spread key with a null value"` FAILS (`"...Dough"` isn't recognized, falls to `additionalProperties`'s four shapes, none of which match a `null` value — actually check this: `null` might currently be rejected as "not any of the four shapes," which is the right failure reason here). `"rejects a spread key with a non-null value"` and `"rejects a bare ... spread key naming no source"` likely already PASS today (for the wrong reason — no spread recognition at all yet, so both are rejected as ordinary malformed fields) — that's fine, Step 4 confirms they still pass for the *right* reason afterward.

- [ ] **Step 3: Add the `patternProperties` entry**

```ts
// schema.ts:200-223, edgeSchema()'s fields property, before:
      fields: {
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string", minLength: 1 },
            fieldShape(),
            {
              type: "object",
              required: ["many"],
              properties: { many: { type: "string", minLength: 1 } },
              additionalProperties: false,
            },
            { type: "boolean" },
            literalFieldShape(),
          ],
        },
      },

// after:
      fields: {
        type: "object",
        patternProperties: {
          "^\\.\\.\\..+$": { type: "null" },
        },
        additionalProperties: {
          oneOf: [
            { type: "string", minLength: 1 },
            fieldShape(),
            {
              type: "object",
              required: ["many"],
              properties: { many: { type: "string", minLength: 1 } },
              additionalProperties: false,
            },
            { type: "boolean" },
            literalFieldShape(),
          ],
        },
      },
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run schema.test.ts`
Expected: all three new tests PASS. `"rejects a bare ... spread key naming no source"` passes because `"..."` (three dots, nothing after) doesn't match `^\.\.\..+$` (which requires at least one character after the dots), so it falls to `additionalProperties`'s four shapes instead, none of which accept a `null` value — rejected, correctly, just via the pre-existing path rather than the new one.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Regenerate schemas and commit**

```bash
cd spikes/ts-prototype && npm run generate:schemas
git add spikes/ts-prototype/src/schema.ts spikes/ts-prototype/src/schema.test.ts schemas/edge.schema.json
git commit -m "Recognize ...Name spread keys in edgeSchema()"
```

---

## Task 3: Resolve spread in `parseEdgeFile`

**Files:**
- Modify: `spikes/ts-prototype/src/elaborate.ts:122-161` (`parseEdgeFile`)
- Test: `spikes/ts-prototype/src/elaborate.test.ts` (new tests in `describe("parseEdgeFile", ...)`)

**Interfaces:**
- Consumes: `LiteralFieldDef` (Task 1), the `patternProperties`-validated `...Name:` key shape (Task 2).
- Produces: `parseEdgeFile` expands exactly one `...Name` key (error on more than one) into the resolved source edge's own `fields`, applies every other locally-declared key as a whole-field override, and inherits the source's `index` unless the local file declares its own.

- [ ] **Step 1: Write the failing tests**

In `elaborate.test.ts`, add inside `describe("parseEdgeFile", ...)`, after Task 1's literal-field tests:

```ts
  it("spreads a source edge's fields, then applies local overrides", () => {
    const yaml = `
label: Baked Cookies
description: The dough, baked
fields:
  "...Dough":
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat
`;
    const doughEdge: AnyEdgeDef = {
      name: "Dough",
      label: "Dough",
      description: "d",
      fields: {
        title: { type: "utf8", label: "Title", description: "d", nullable: false },
        servings: { type: "uint8", label: "Servings", description: "d", nullable: false },
      },
    };
    const edge = parseEdgeFile(yaml, "BakedCookies", (referencedName) => {
      expect(referencedName).toBe("Dough");
      return doughEdge;
    });
    expect(edge.fields.title).toEqual(doughEdge.fields.title);
    expect(edge.fields.servings).toEqual(doughEdge.fields.servings);
    expect(edge.fields.done).toEqual({
      type: "bool",
      label: "Done",
      description: "Whether the cookies have cooled enough to eat",
    });
  });

  it("lets a local field override a spread-sourced field of the same name, whole-value replacement", () => {
    const yaml = `
label: Cookies
description: The finished, cooled cookies
fields:
  "...BakedCookies":
  done: true
`;
    const bakedCookiesEdge: AnyEdgeDef = {
      name: "BakedCookies",
      label: "Baked Cookies",
      description: "d",
      fields: {
        title: { type: "utf8", label: "Title", description: "d", nullable: false },
        done: { type: "bool", label: "Done", description: "d" },
      },
    };
    const edge = parseEdgeFile(yaml, "Cookies", () => bakedCookiesEdge);
    expect(edge.fields.title).toEqual(bakedCookiesEdge.fields.title);
    expect(edge.fields.done).toEqual({ literal: true });
  });

  it("inherits index from the spread source when not locally declared", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  "...Todo":
  is_complete: true
`;
    const todoEdge: AnyEdgeDef = {
      name: "Todo",
      label: "Todo",
      description: "d",
      index: "id",
      fields: {
        id: { type: "utf8", label: "ID", description: "d", nullable: false },
      },
    };
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => todoEdge);
    expect(edge.index).toBe("id");
  });

  it("rejects more than one spread key in the same fields map", () => {
    const yaml = `
label: X
description: d
fields:
  "...A":
  "...B":
`;
    expect(() =>
      parseEdgeFile(yaml, "X", () => {
        throw new Error("unreachable");
      }),
    ).toThrow(/at most one/i);
  });

  it("rejects a spread source that resolves to a field, not an edge", () => {
    const yaml = `
label: X
description: d
fields:
  "...title":
`;
    const titleField = { type: "utf8" as const, label: "Title", description: "d", nullable: false as const };
    expect(() => parseEdgeFile(yaml, "X", () => titleField)).toThrow(/spread is for edges only/i);
  });
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run elaborate.test.ts`
Expected: all six new tests FAIL — `parseEdgeFile` doesn't recognize `...`-prefixed keys yet, so they fall through the existing per-field loop's `else` branches, producing wrong results (or, for the "resolver should not be called"-style tests, calling `resolveField` unexpectedly with a name like `"...Dough"` rather than `"Dough"`).

- [ ] **Step 3: Implement spread resolution**

```ts
// elaborate.ts, top of the file, add near the other module-level regexes/constants if any exist, otherwise directly above parseEdgeFile:
const SPREAD_KEY = /^\.\.\.(.+)$/;
```

```ts
// elaborate.ts:122-161, parseEdgeFile, before:
export function parseEdgeFile(yamlText: string, name: string, resolveField: FieldResolver): AnyEdgeDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.edge files don't declare "name" — the filename is the name.`);
  }
  const { label, description, index, fields } = raw as {
    label?: unknown;
    description?: unknown;
    index?: unknown;
    fields?: Record<string, unknown>;
  };

  const resolvedFields: Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (typeof value === "boolean") {
      resolvedFields[key] = { literal: value };
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      requireIndex(resolved, `"${key}.many"`);
      resolvedFields[key] = { many: resolved };
    } else if (value !== null && typeof value === "object" && "literal" in value) {
      resolvedFields[key] = value as LiteralFieldDef;
    } else {
      resolvedFields[key] = value as FieldDef;
    }
  }

  return defineEdge({
    name,
    label: label as string,
    description: description as string,
    ...(typeof index === "string" && { index }),
    fields: resolvedFields,
  });
}

// after:
export function parseEdgeFile(yamlText: string, name: string, resolveField: FieldResolver): AnyEdgeDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.edge files don't declare "name" — the filename is the name.`);
  }
  const { label, description, index, fields } = raw as {
    label?: unknown;
    description?: unknown;
    index?: unknown;
    fields?: Record<string, unknown>;
  };

  const fieldEntries = Object.entries(fields ?? {});
  const spreadEntries = fieldEntries.filter(([key]) => SPREAD_KEY.test(key));
  if (spreadEntries.length > 1) {
    throw new Error(
      `"fields" may spread from at most one source, found ${spreadEntries.length}: ${spreadEntries.map(([key]) => key).join(", ")}.`,
    );
  }

  const resolvedFields: Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  let spreadIndex: string | undefined;
  if (spreadEntries.length === 1) {
    const [spreadKey] = spreadEntries[0]!;
    const sourceName = spreadKey.match(SPREAD_KEY)![1]!;
    const source = resolveField(sourceName);
    if (!("fields" in source)) {
      throw new Error(`"...${sourceName}" references a field, not an edge — spread is for edges only.`);
    }
    Object.assign(resolvedFields, source.fields);
    spreadIndex = source.index;
  }

  for (const [key, value] of fieldEntries) {
    if (SPREAD_KEY.test(key)) continue;
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (typeof value === "boolean") {
      resolvedFields[key] = { literal: value };
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      requireIndex(resolved, `"${key}.many"`);
      resolvedFields[key] = { many: resolved };
    } else if (value !== null && typeof value === "object" && "literal" in value) {
      resolvedFields[key] = value as LiteralFieldDef;
    } else {
      resolvedFields[key] = value as FieldDef;
    }
  }

  return defineEdge({
    name,
    label: label as string,
    description: description as string,
    ...(typeof index === "string"
      ? { index }
      : spreadIndex !== undefined && { index: spreadIndex }),
    fields: resolvedFields,
  });
}
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including the six added in Step 1.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/elaborate.test.ts
git commit -m "Resolve ...Name spread in parseEdgeFile"
```

---

## Task 4: Rebuild the recipe fixtures on real spread, update dependent tests

**Files:**
- Modify: `examples/recipe/src/edges/BakedCookies.edge`
- Modify: `examples/recipe/src/edges/Cookies.edge`
- Modify: `examples/recipe/src/nodes/bake.node`
- Modify: `examples/recipe/src/nodes/cool.node`
- Modify: `spikes/ts-prototype/src/elaborate.test.ts:1061-1089` (`"loads the real recipe example..."`)
- Modify: `spikes/ts-prototype/src/runtime.test.ts:493-545` (`"runs the real recipe topology end-to-end..."`)

**Interfaces:**
- Consumes: spread (Task 3), the literal field kind (Task 1).
- Produces: nothing consumed by a later task — this is the plan's last task.

- [ ] **Step 1: Rewrite the two edge files**

```yaml
# examples/recipe/src/edges/BakedCookies.edge, before:
label: Baked Cookies
description: The dough, baked — still too hot to eat
fields:
  title:
    type: utf8
    label: Title
    description: The name of the dish being made
    nullable: false
    validations:
      minLength: 3
      maxLength: 200
  servings:
    type: uint8
    label: Servings
    description: How many servings this batch makes
    nullable: false
    validations:
      min: 1
      max: 100

# after:
label: Baked Cookies
description: The dough, baked — still too hot to eat
fields:
  "...Dough":
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat
```

```yaml
# examples/recipe/src/edges/Cookies.edge, before:
label: Cookies
description: The finished, cooled cookies — ready to eat
fields:
  title:
    type: utf8
    label: Title
    description: The name of the dish
    nullable: false
    validations:
      minLength: 3
      maxLength: 200
  servings:
    type: uint8
    label: Servings
    description: How many servings this batch makes
    nullable: false
    validations:
      min: 1
      max: 100
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat

# after:
label: Cookies
description: The finished, cooled cookies — ready to eat
fields:
  "...BakedCookies":
  done: true
```

- [ ] **Step 2: Update the two node files' examples to include `done`**

`BakedCookies` now has a real `done` field (it didn't before this plan), so `bake.node`'s `expect` needs it:

```yaml
# examples/recipe/src/nodes/bake.node, examples[0].expect, before:
    expect:
      BakedCookies:
        title: "Chocolate Chip Cookies"
        servings: 24

# after:
    expect:
      BakedCookies:
        title: "Chocolate Chip Cookies"
        servings: 24
        done: false
```

`cool.node`'s `given` should match the real `BakedCookies` shape it now receives:

```yaml
# examples/recipe/src/nodes/cool.node, examples[0].given, before:
  - given:
      BakedCookies:
        title: "Chocolate Chip Cookies"
        servings: 24

# after:
  - given:
      BakedCookies:
        title: "Chocolate Chip Cookies"
        servings: 24
        done: false
```

(`cool.node`'s `expect` already has `done: true` — no change needed there.)

- [ ] **Step 3: Update `elaborate.test.ts`'s real-recipe-example test**

Add field-shape assertions to `"loads the real recipe example — a many(Ingredient) origin fanning out into a mix/preheat allOf join at bake"` (around line 1061), after the existing `expect(result.edges.Failed_Dough_Oven).toBeDefined();` line:

```ts
    expect(result.edges.BakedCookies!.fields.title).toEqual(result.edges.Dough!.fields.title);
    expect(result.edges.BakedCookies!.fields.servings).toEqual(result.edges.Dough!.fields.servings);
    expect(result.edges.BakedCookies!.fields.done).toEqual({
      type: "bool",
      label: "Done",
      description: "Whether the cookies have cooled enough to eat",
    });
    expect(result.edges.Cookies!.fields.title).toEqual(result.edges.Dough!.fields.title);
    expect(result.edges.Cookies!.fields.done).toEqual({ literal: true });
```

- [ ] **Step 4: Update `runtime.test.ts`'s real-recipe-topology test**

The hand-written `bake` implementation needs to return `done: false` now that `BakedCookies` requires it (`cool`'s implementation already spreads `...payload` before overriding `done: true`, so it needs no change — it already carries the new field through correctly):

```ts
// runtime.test.ts:509-511, before:
        [
          "bake",
          `export default function bake(payload) { return { title: payload.Dough.title, servings: payload.Dough.servings }; }`,
        ],

// after:
        [
          "bake",
          `export default function bake(payload) { return { title: payload.Dough.title, servings: payload.Dough.servings, done: false }; }`,
        ],
```

```ts
// runtime.test.ts:532-535, before:
      expect(log.latest("BakedCookies", "thread-1")).toEqual({
        title: recipe.title,
        servings: recipe.servings,
      });

// after:
      expect(log.latest("BakedCookies", "thread-1")).toEqual({
        title: recipe.title,
        servings: recipe.servings,
        done: false,
      });
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

Run: `grep -rn "title:\|servings:" examples/recipe/src/edges/BakedCookies.edge examples/recipe/src/edges/Cookies.edge` (from repo root)
Expected: no output — confirms the hand-duplicated fields are actually gone, not just reformatted.

- [ ] **Step 6: Commit**

```bash
git add examples/recipe/src/edges/BakedCookies.edge examples/recipe/src/edges/Cookies.edge examples/recipe/src/nodes/bake.node examples/recipe/src/nodes/cool.node spikes/ts-prototype/src/elaborate.test.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Rebuild BakedCookies/Cookies on real spread, replacing hand-duplicated fields"
```
