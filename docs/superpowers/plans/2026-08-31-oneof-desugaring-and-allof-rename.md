# `oneOf` Desugaring + `every`→`allOf` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `any` as a runtime `InputSpec` kind, replacing it with `oneOf`-shaped authoring sugar that desugars into N ordinary single-input nodes at elaboration time; separately, rename `every` (input) to `allOf` to match its already-identical-meaning output-side sibling.

**Architecture:** `elaborate()` gains a desugaring pass: a `.node` file whose `input` is `{oneOf: [...]}` expands into N `NodeDecl`s (`<Name>__<EdgeName>`, double underscore) instead of one `NodeDecl` with a tagged-union `InputSpec`. A name-alias map threads through to `.topology` resolution so `.topology` files can still reference the original name, expanding transparently to all shadows. `every`→`allOf` is a pure identifier rename with no behavior change, reusing the existing output `allOf()` helper rather than adding a new one.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest, `npm run typecheck` (`tsc --noEmit`).

**Spec:** `docs/superpowers/specs/2026-08-31-any-desugaring-design.md` — this plan implements it in full, including the folded-in `every`→`allOf` section and the "Also folded in" addendum. Read the spec's Motivation and semantics-correction sections before Task 1; they explain *why*, this plan only covers *how*.

## Global Constraints

- All work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- Follow TDD: write the failing test, watch it fail for the right reason, write minimal code, watch it pass. Tasks below show test code before implementation code for this reason — implement in that order even though both are shown together for readability.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's own convention).
- Commit after each task, one task per commit, matching this repo's existing granular-commit history.
- This repo's git commits get their timestamp shifted to outside 9am–5pm local weekday if the real time falls inside that window (a personal-project convention) — check `date` before each commit; if inside that window, use `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible evening time the same day.
- Regenerate `schemas/*.json` (`npm run generate:schemas` from `spikes/ts-prototype/`) and check the diff any time `schema.ts` changes.

---

## Task 1: Remove `any` as a runtime `InputSpec` kind

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts:224-260` (`InputSpec`, `InputPayload`)
- Modify: `spikes/ts-prototype/src/membrane.ts:254-270,419-452` (`AnyInvoke`, `MembraneInvoke`, the `any` branch)
- Modify: `spikes/ts-prototype/src/runtime.ts:63-78,150-170` (`AnyMultiInvoke`, `Failed<In>` routing)
- Modify: `spikes/ts-prototype/src/define.ts:191-200` (delete the `any()` helper)
- Modify: `spikes/ts-prototype/src/elaborate.ts:168-187` (`resolveInputSpec` — drop the `any` recognition branch entirely; `{oneOf: [...]}` is not yet recognized either, so it falls through to "Unrecognized input shape", same as any garbage input, until Task 3)
- Modify: `spikes/ts-prototype/src/membrane.test.ts` (delete lines 404-487: the `nodeAny` fixture and `describe("membrane — any", ...)` block; update the import on line 2)
- Modify: `spikes/ts-prototype/src/runtime.test.ts` (delete lines 292-377: both `any`-input tests; update the import on line 6)
- Modify: `spikes/ts-prototype/src/elaborate.test.ts` (delete lines 314-330: `"resolves an any: input..."` test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `InputSpec` is now `{kind:"single"} | {kind:"every"}` only (still `every` — that renames in Task 7). No node ever has `kind: "any"` after this task; `elaborate()` throws `Unrecognized "input" shape` for `{any: [...]}` or `{oneOf: [...]}` YAML until Task 3 builds real `oneOf` support.

- [ ] **Step 1: Delete the obsolete `any`-specific tests first, confirming the rest of the suite still compiles and passes**

In `membrane.test.ts`, delete lines 404-487 (the `nodeAny` comment+fixture and the whole `describe("membrane — any", ...)` block — starts at `// \`any\` is the coproduct-shaped sibling of \`every\`...` and ends at the `});` that closes the describe block, right before `describe("membrane — envelope", ...)`). Update the import:

```ts
// Before:
import { any, defineEdge, defineField, defineNode, every, single } from "./define.js";
// After:
import { defineEdge, defineField, defineNode, every, single } from "./define.js";
```

In `runtime.test.ts`, delete lines 292-377 (both `it("fires an any-input node...")` and `it("still collects an any-input node's failure...")`, including the blank line between them). Update the import:

```ts
// Before:
import { any, defineEdge, defineField, defineNode, every, single } from "./define.js";
// After:
import { defineEdge, defineField, defineNode, every, single } from "./define.js";
```

In `elaborate.test.ts`, delete lines 314-330 (`it("resolves an any: input into multiple edges, in declared order", ...)`).

- [ ] **Step 2: Run the full suite — expect failures from the still-present runtime `any` code referencing things the tests no longer cover, but no new failures from the deletions themselves**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all remaining tests PASS (deleting tests never breaks anything by itself) — this step just confirms the deletions were clean cuts, no orphaned references left in the test files.

- [ ] **Step 3: Remove `any` from `types.ts`**

```ts
// types.ts:237-240, before:
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "every"; edges: AnyEdgeDef[] }
  | { kind: "any"; edges: AnyEdgeDef[] };

// after:
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "every"; edges: AnyEdgeDef[] };
```

```ts
// types.ts:251-260, before:
export type InputPayload<I extends InputSpec> = I extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : I extends { kind: "every"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
    : I extends { kind: "any"; edges: infer Es extends AnyEdgeDef[] }
      ? { [Idx in keyof Es]: Es[Idx] extends AnyEdgeDef ? Tagged<Es[Idx]> : never }[number]
      : never;

// after:
export type InputPayload<I extends InputSpec> = I extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : I extends { kind: "every"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
    : never;
```

Also update the doc comment directly above `InputSpec` (types.ts:224-236) — it currently says "a single edge, or several via `every`/`any`... `any` is its coproduct-shaped sibling". Replace with:

```ts
/**
 * A node's input shape (docs/design.md §5) — a single edge, or several via
 * `every`, a readiness condition the membrane resolves against a
 * `correlation_id`'s per-edge-type logs, never a synchronous join or an
 * accumulator (docs/design-history.md, "The membrane"). Mirrors OutputSpec's
 * "kind is the discriminant" idiom on purpose — `single` here is the same
 * shape `single()` already produces for OutputSpec, so the same helper
 * serves both.
 */
```

`Tagged` (types.ts, defined near `OutputResult`) stays — it's still used by `OutputResult`'s `oneOf` branch, only its use from `InputPayload` is removed.

- [ ] **Step 4: Remove `any` from `membrane.ts`**

```ts
// membrane.ts:254-264, delete entirely:
/**
 * What `membrane()` returns for an `any`-input node: same call shape as
 * `EveryInvoke` (a readiness check against a correlation_id's logs), but
 * resolves as soon as the *first* declared edge has appeared rather than
 * requiring all of them.
 */
type AnyInvoke<In extends InputSpec, O extends OutputSpec> = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<OutputResult<O> | Failed<In> | undefined>;
```

```ts
// membrane.ts:266-270, before:
type MembraneInvoke<In extends InputSpec, O extends OutputSpec> = In extends { kind: "single" }
  ? SingleInvoke<In, O>
  : In extends { kind: "every" }
    ? EveryInvoke<In, O>
    : AnyInvoke<In, O>;

// after:
type MembraneInvoke<In extends InputSpec, O extends OutputSpec> = In extends { kind: "single" }
  ? SingleInvoke<In, O>
  : EveryInvoke<In, O>;
```

```ts
// membrane.ts:419-452, delete the entire `if (nodeDef.input.kind === "any") { ... }` block
// (everything from `if (nodeDef.input.kind === "any") {` through its matching `}`,
// inclusive of the blank line right after it).
```

After deletion, the function should read (tail of `membrane()`, following the `every` block's closing `}`):

```ts
    return invoke as MembraneInvoke<In, O>;
  }

  // Exhaustiveness guard: InputSpec is a closed union of single/every, so
  // nodeDef.input is `never` here — a future sibling kind would fail loudly
  // instead of silently falling through to this branch's behavior.
  const unreachable: never = nodeDef.input;
  throw new Error(`Unrecognized InputSpec kind: ${JSON.stringify(unreachable)}`);
}
```

(Update the comment's `"InputSpec is a closed union of single/every/any"` to `"single/every"` and drop the `(design-history.md's still-deferred \`first\`/\`each\`)` parenthetical, which was about `any`'s neighbors, not relevant here.)

Also update the file header comment (membrane.ts:1-7) — `"Covers \`single\`, \`every\`, and \`any\` InputSpecs..."` becomes `"Covers \`single\` and \`every\` InputSpecs..."`.

- [ ] **Step 5: Remove `any` from `runtime.ts`**

```ts
// runtime.ts:63-78, before:
 * `AnyMultiInvoke` covers both `every`- and `any`-input nodes — their
 * `membrane()` call shape is identical (`correlationId, log, identity?`);
 * only what's inside `In` differs, and that's erased here too. (Named
 * "Multi" rather than reusing the real `any` InputSpec kind's name, to
 * avoid the two meanings of "any" colliding in this file.)
 */
type AnySingleInvoke = (
  payload: unknown,
  correlationId: string,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;
type AnyMultiInvoke = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;

// after:
 * `AnyEveryInvoke` names the cast for `every`-input nodes' call shape
 * (`correlationId, log, identity?`); `In` is erased here too.
 */
type AnySingleInvoke = (
  payload: unknown,
  correlationId: string,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;
type AnyEveryInvoke = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;
```

```ts
// runtime.ts:150-154, before:
    } else {
      const multi = await (membrane(nodeDef) as AnyMultiInvoke)(correlationId, log, identity);
      if (multi === undefined) return false;
      result = multi;
    }

// after:
    } else {
      const every = await (membrane(nodeDef) as AnyEveryInvoke)(correlationId, log, identity);
      if (every === undefined) return false;
      result = every;
    }
```

```ts
// runtime.ts:156-171, before:
    fired.add(nodeName);
    if (looksLikeFailed(result)) {
      if (nodeDef.input.kind === "single") {
        log.append(failedEdgeName(nodeDef.input.edge.name), correlationId, result);
      } else if (nodeDef.input.kind === "every") {
        // The synthesized combo edge is flat (elaborate.ts's synthesizeEveryFailedEdges:
        // {A, B, reason}, no `input` wrapper) — spread the bag alongside reason to match.
        const bag = result.input as Record<string, unknown>;
        log.append(failedEveryEdgeName(nodeDef.input.edges), correlationId, { ...bag, reason: result.reason });
      } else {
        // any-input Failed<In> is tagged ({edge, payload}); no synthesized edge yet
        // (elaborate.ts's synthesis covers single-input and every-combos only) —
        // still collected here.
        failures.push({ node: nodeName, failed: result });
      }
    } else {
      logOutput(log, nodeDef.output, result, correlationId);
    }
    return true;

// after (InputSpec is single|every only now, so the third branch is gone —
// note `failures` becomes unused by this function; keep RunResult.failures
// in the return type for now, always empty, since removing it entirely is
// a public-API change out of scope for this task):
    fired.add(nodeName);
    if (looksLikeFailed(result)) {
      if (nodeDef.input.kind === "single") {
        log.append(failedEdgeName(nodeDef.input.edge.name), correlationId, result);
      } else {
        // The synthesized combo edge is flat (elaborate.ts's synthesizeEveryFailedEdges:
        // {A, B, reason}, no `input` wrapper) — spread the bag alongside reason to match.
        const bag = result.input as Record<string, unknown>;
        log.append(failedEveryEdgeName(nodeDef.input.edges), correlationId, { ...bag, reason: result.reason });
      }
    } else {
      logOutput(log, nodeDef.output, result, correlationId);
    }
    return true;
```

Update the file header's `Failed<In>` routing bullet (runtime.ts, near the top, currently describes `single`+`every` routing and calls out `any` as still-unrouted) — remove the `any`-input sentence entirely, since after this task `failures` is never populated by anything (it stays in `RunResult` only because removing it is a separate, out-of-scope public-API change):

```
 * - **`Failed<In>` routing exists for `single`- and `every`-input nodes —
 *   every InputSpec kind there is.** ...(keep the existing single/every
 *   explanation, delete the "An `any`-input node's..." sentence that follows it)
```

- [ ] **Step 6: Delete the `any()` helper from `define.ts`**

```ts
// define.ts:191-200, delete entirely:
/**
 * The coproduct-shaped sibling of `every` (docs/design-history.md, "`every`
 * lands... any, by contrast, is about breadth"): fires once the first of
 * several distinct declared edges has appeared for the current
 * correlation_id — same readiness mechanism as `every`, `min` instead of
 * `max`. Fn receives a `{edge, payload}` tag so it knows which one arrived.
 */
export function any<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "any"; edges: Es } {
  return { kind: "any", edges };
}
```

- [ ] **Step 7: Remove the `any` recognition branch from `elaborate.ts`'s `resolveInputSpec`**

```ts
// elaborate.ts:176-187, before:
function resolveInputSpec(input: unknown, resolveEdge: EdgeResolver): InputSpec {
  if (typeof input === "string") {
    return { kind: "single", edge: resolveEdge(input) };
  }
  if (input !== null && typeof input === "object" && "every" in input) {
    return { kind: "every", edges: resolveEdgeNameList(input.every, "input.every", resolveEdge) };
  }
  if (input !== null && typeof input === "object" && "any" in input) {
    return { kind: "any", edges: resolveEdgeNameList(input.any, "input.any", resolveEdge) };
  }
  throw new Error(`Unrecognized "input" shape: ${JSON.stringify(input)}.`);
}

// after:
function resolveInputSpec(input: unknown, resolveEdge: EdgeResolver): InputSpec {
  if (typeof input === "string") {
    return { kind: "single", edge: resolveEdge(input) };
  }
  if (input !== null && typeof input === "object" && "every" in input) {
    return { kind: "every", edges: resolveEdgeNameList(input.every, "input.every", resolveEdge) };
  }
  throw new Error(`Unrecognized "input" shape: ${JSON.stringify(input)}.`);
}
```

Update its doc comment (elaborate.ts:168-175) to drop the `\`{ any: [...] }\`` mention — Task 3 will add a fresh comment about `oneOf` when it adds real support for it.

- [ ] **Step 8: Typecheck and full suite**

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean, no errors (this is the real proof `any` is fully gone — if any reference to `kind: "any"` or `AnyInvoke` survived anywhere, this fails).

Run: `npx vitest run`
Expected: all tests PASS. Test count drops by 8 (membrane.test.ts) + 2 (runtime.test.ts) + 1 (elaborate.test.ts) = 11 fewer than before this task.

- [ ] **Step 9: Commit**

```bash
cd /Users/jordan/code/weir
date  # check whether to shift the commit timestamp per the Global Constraints note
git add spikes/ts-prototype/src/types.ts spikes/ts-prototype/src/membrane.ts \
  spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/define.ts \
  spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/membrane.test.ts \
  spikes/ts-prototype/src/runtime.test.ts spikes/ts-prototype/src/elaborate.test.ts
git commit -m "Remove any as a runtime InputSpec kind

Per docs/superpowers/specs/2026-08-31-any-desugaring-design.md. oneOf-shaped
.node YAML is unrecognized until Task 3 builds real desugaring support -
no real .node file in this repo used any: yet, so nothing regresses."
```

---

## Task 2: Rename `schema.ts`'s `any` conditional to `oneOf`

**Files:**
- Modify: `spikes/ts-prototype/src/schema.ts:272-278,328-333`
- Modify: `spikes/ts-prototype/src/schema.test.ts:480-515` (rename `any` → `oneOf` in the three tests)
- Modify: `schemas/node.schema.json` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: nothing new.
- Produces: `nodeSchema()` accepts `.node` YAML with `input: {oneOf: [...]}` (JSON-Schema validation only — `elaborate()` still doesn't resolve it until Task 3; that's fine, schema validation and elaboration are independent layers, same as today).

- [ ] **Step 1: Update the three `any`-shape tests in `schema.test.ts` to use `oneOf`, and watch them fail**

```ts
// schema.test.ts:480-490, before:
  it("accepts an any input with a single-tag given", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { any: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: { Todo: { title: "Buy milk" } }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

// after:
  it("accepts a oneOf input with a single-tag given", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { oneOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: { Todo: { title: "Buy milk" } }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
```

```ts
// schema.test.ts:492-501, before:
  it("rejects an any input whose given has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { any: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: {}, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

// after:
  it("rejects a oneOf input whose given has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { oneOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: {}, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });
```

```ts
// schema.test.ts:503-515, before:
  it("rejects an any input whose given has more than one tag", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { any: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [
        {
          given: { Todo: { title: "Buy milk" }, TodoList: { title: "Groceries", tasks: [] } },
          expect: { TodoList: { title: "Groceries", tasks: [] } },
        },
      ],
    });
    expect(valid).toBe(false);
  });

// after:
  it("rejects a oneOf input whose given has more than one tag", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { oneOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [
        {
          given: { Todo: { title: "Buy milk" }, TodoList: { title: "Groceries", tasks: [] } },
          expect: { TodoList: { title: "Groceries", tasks: [] } },
        },
      ],
    });
    expect(valid).toBe(false);
  });
```

Run: `cd spikes/ts-prototype && npx vitest run src/schema.test.ts -t "oneOf input"`
Expected: FAIL — `nodeSchema()` doesn't recognize `oneOf` on `input` yet, so `valid` comes back differently than expected in the accept case (or the reject cases pass vacuously for the wrong reason — check the accept case fails specifically, since that's the one proving the shape is recognized).

- [ ] **Step 2: Rename `schema.ts`'s `any` conditional and property key to `oneOf`**

```ts
// schema.ts:272-278, before:
    // any: exactly one of several declared edges arrives, tagged by name in
    // given — mirrors oneOf's expect shape (docs/design-history.md, "`every`
    // lands... any, by contrast, is about breadth").
    {
      if: { properties: { input: { type: "object", required: ["any"] } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },

// after:
    // oneOf (input position): exactly one of several declared edges arrives,
    // tagged by name in given — mirrors oneOf's own expect shape on the
    // output side (docs/superpowers/specs/2026-08-31-any-desugaring-design.md).
    // Desugars into N single-input nodes at elaboration time (elaborate.ts);
    // this only validates the authoring-level YAML shape.
    {
      if: { properties: { input: { type: "object", required: ["oneOf"] } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },
```

```ts
// schema.ts:328-333, before:
          {
            type: "object",
            properties: { any: edgeNameList },
            required: ["any"],
            additionalProperties: false,
          },

// after:
          {
            type: "object",
            properties: { oneOf: edgeNameList },
            required: ["oneOf"],
            additionalProperties: false,
          },
```

- [ ] **Step 3: Typecheck, run the schema tests, regenerate schemas, check the diff**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/schema.test.ts`
Expected: both clean/green.

Run: `npm run generate:schemas`
Expected: `schemas/node.schema.json` changes — the `any` key becomes `oneOf` in the `input.oneOf` list and in the `required` array of its conditional. Confirm via `git diff schemas/node.schema.json` from repo root that only this key rename appears, nothing else.

Run: `npx vitest run` (full suite, from `spikes/ts-prototype/`)
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/schema.ts spikes/ts-prototype/src/schema.test.ts schemas/node.schema.json
git commit -m "Rename schema.ts's any input shape to oneOf

Authoring-level YAML validation only - elaborate() doesn't resolve
oneOf-shaped input yet, that's the next task."
```

---

## Task 3: `elaborate.ts` — `oneOf` desugaring into N single-input `NodeDecl`s

**Files:**
- Modify: `spikes/ts-prototype/src/elaborate.ts` (new `parseOneOfNodeFile` function; node-loading loop in `elaborate()`)
- Modify: `spikes/ts-prototype/src/elaborate.test.ts` (new tests)

**Interfaces:**
- Consumes: `resolveEdge: EdgeResolver` (existing), `resolveOutputSpec`/`resolveEdgeNameList` (existing private functions in the same file).
- Produces: `elaborate()`'s `nodes` record contains `<Name>__<EdgeName>` entries (never the bare original name) for any `.node` file whose `input` is `{oneOf: [...]}`. This task does *not* yet make `.topology` able to reference the original name — that's Task 4. A `.topology` file referencing a oneOf-desugared node's original name will still throw `Cannot resolve` until then; no real example file does this today, so nothing regresses.

- [ ] **Step 1: Write the failing tests**

Add to `elaborate.test.ts`, in the `describe("elaborate", ...)` block (same describe block containing the existing `synthesizes a Failed_<EdgeName> edge...` test — insert after that test, before `"lets a .node file declare input: Failed_<EdgeName>..."`):

```ts
  it("desugars a oneOf: input into N single-input NodeDecls, named <Node>__<Edge>", async () => {
    const root = await writeFixture({
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Recovered.edge": `
description: A recovered value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  oneOf:
    - Failed_Todo
    - Failed_Person
output: Recovered
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Recovered:
        value: "recovered todo"
  - given:
      Failed_Person:
        input: "bad person"
    expect:
      Recovered:
        value: "recovered person"
`,
    });

    const result = await elaborate(root);

    expect(Object.keys(result.nodes).sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
    expect(result.nodes.HandleFailed__Failed_Todo!.input).toEqual({ kind: "single", edge: result.edges.Failed_Todo });
    expect(result.nodes.HandleFailed__Failed_Todo!.output).toEqual({ kind: "single", edge: result.edges.Recovered });
    expect(result.nodes.HandleFailed__Failed_Todo!.examples).toEqual([
      { given: { Failed_Todo: { input: "bad todo" } }, expect: { Recovered: { value: "recovered todo" } } },
    ]);
    expect(result.nodes.HandleFailed__Failed_Person!.input).toEqual({
      kind: "single",
      edge: result.edges.Failed_Person,
    });
    expect(result.nodes.HandleFailed__Failed_Person!.examples).toEqual([
      { given: { Failed_Person: { input: "bad person" } }, expect: { Recovered: { value: "recovered person" } } },
    ]);
    expect(result.nodes.HandleFailed).toBeUndefined();
  });

  it("gives a oneOf-desugared shadow no examples key when none of the file's examples tag its edge", async () => {
    const root = await writeFixture({
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Recovered.edge": `
description: A recovered value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  oneOf:
    - Failed_Todo
    - Failed_Person
output: Recovered
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Recovered:
        value: "recovered todo"
`,
    });

    const result = await elaborate(root);

    expect(result.nodes.HandleFailed__Failed_Todo!.examples).toHaveLength(1);
    expect(result.nodes.HandleFailed__Failed_Person!.examples).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/elaborate.test.ts -t "desugars a oneOf"`
Expected: FAIL — `Unrecognized "input" shape` (from `resolveInputSpec`, since `oneOf` isn't recognized there and there's no separate handling yet).

- [ ] **Step 3: Add `parseOneOfNodeFile` to `elaborate.ts`**

Add this function right after `parseNodeFile` (elaborate.ts, after line 253's closing `}`):

```ts
/**
 * Parses a `.node` file whose `input` is `{ oneOf: [...] }` into N separate
 * `NodeDecl`s, one per listed edge — desugaring sugar, not a real
 * `InputSpec` kind (docs/superpowers/specs/2026-08-31-any-desugaring-design.md).
 * Named `<name>__<edgeName>`, double underscore (edge names can already
 * contain single underscores, e.g. `Failed_Todo_TodoList`, so a single
 * underscore join would be ambiguous to a human reading the name).
 *
 * Each example in the original file's `examples` array is routed to the one
 * shadow whose edge name appears as its `given`'s tag key (schema.ts's
 * `taggedOne` already guarantees exactly one tag per example at the
 * authoring level). A shadow with no matching examples gets no `examples`
 * key at all — the same "examples optional" looseness `parseNodeFile`
 * already has, not a new gap this introduces.
 */
function parseOneOfNodeFile(
  yamlText: string,
  name: string,
  resolveEdge: EdgeResolver,
): Record<string, NodeDecl> {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.node files don't declare "name" — the filename is the name.`);
  }
  if ("fn" in raw) {
    throw new Error(`.node files declare the contract only (docs/design.md §10) — "fn" belongs in the implementation tree, not here.`);
  }
  const { label, description, input, output, examples, closure } = raw as {
    label?: unknown;
    description?: unknown;
    input?: { oneOf: unknown };
    output?: unknown;
    examples?: unknown;
    closure?: unknown;
  };

  const edges = resolveEdgeNameList(input?.oneOf, "input.oneOf", resolveEdge);
  const outputSpec = resolveOutputSpec(output, resolveEdge);
  const allExamples = (examples as { given: Record<string, unknown>; expect: unknown }[] | undefined) ?? [];

  const decls: Record<string, NodeDecl> = {};
  for (const edge of edges) {
    const shadowName = `${name}__${edge.name}`;
    const shadowExamples = allExamples.filter((example) => edge.name in example.given);
    decls[shadowName] = {
      name: shadowName,
      ...(typeof label === "string" && { label }),
      ...(typeof description === "string" && { description }),
      input: { kind: "single", edge },
      output: outputSpec,
      ...(shadowExamples.length > 0 && { examples: shadowExamples as NodeDecl["examples"] }),
      ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),
    };
  }
  return decls;
}
```

- [ ] **Step 4: Wire it into `elaborate()`'s node-loading loop**

```ts
// elaborate.ts:425-428, before:
  const nodes: Record<string, NodeDecl> = {};
  for (const [name, text] of nodeTextByName) {
    nodes[name] = parseNodeFile(text, name, resolveEdge);
  }

// after:
  const nodes: Record<string, NodeDecl> = {};
  for (const [name, text] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown };
    const isOneOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "oneOf" in raw.input;
    if (isOneOf) {
      Object.assign(nodes, parseOneOfNodeFile(text, name, resolveEdge));
    } else {
      nodes[name] = parseNodeFile(text, name, resolveEdge);
    }
  }
```

(This re-parses each `.node` file's raw YAML a second time to check its `input` shape, same accepted-tradeoff pattern the `every`-combo pre-scan a few lines above already uses — not fixed here, out of scope.)

- [ ] **Step 5: Run to verify green**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/elaborate.test.ts`
Expected: clean typecheck, all tests PASS including the two new ones.

Run: `npx vitest run` (full suite)
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/elaborate.test.ts
git commit -m "Desugar oneOf: input into N single-input NodeDecls at elaboration time

A .node file's original name isn't a real key in nodes after this - only
its <Name>__<Edge> shadows are. .topology can't reference the original
name yet (next task)."
```

---

## Task 4: `.topology` name-alias expansion

**Files:**
- Modify: `spikes/ts-prototype/src/elaborate.ts` (`NodeNameResolver` signature, `parseTopologyFile`, `elaborate()`'s `resolveNodeName` construction)
- Modify: `spikes/ts-prototype/src/elaborate.test.ts` (update the shared `resolveNodeName` test fixture; new tests)

**Interfaces:**
- Consumes: the `oneOfAliases: Map<string, string[]>` this task builds inside `elaborate()`, from the same loop Task 3 added.
- Produces: `NodeNameResolver` becomes `(name: string) => string[]` (was `(name: string) => void`) — throws if unresolvable, otherwise returns the real underlying node name(s): `[name]` for an ordinary node, all shadow names for a oneOf-desugared original name. `parseTopologyFile`'s `Wiring.origins`/`Wiring.feeds` are built from *expanded* names throughout.

- [ ] **Step 1: Update the existing shared test fixture (this is a signature change, not new behavior — all 10 existing `parseTopologyFile` tests must keep passing unchanged)**

```ts
// elaborate.test.ts:406-410, before:
describe("parseTopologyFile", () => {
  const knownNames = new Set(["A", "B", "C", "birthday"]);
  const resolveNodeName = (name: string): void => {
    if (!knownNames.has(name)) throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
  };

// after:
describe("parseTopologyFile", () => {
  const knownNames = new Set(["A", "B", "C", "birthday"]);
  const resolveNodeName = (name: string): string[] => {
    if (!knownNames.has(name)) throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    return [name];
  };
```

- [ ] **Step 2: Run the existing topology tests to confirm this alone doesn't break anything**

Run: `cd spikes/ts-prototype && npx vitest run src/elaborate.test.ts -t "parseTopologyFile"`
Expected: FAIL at this point — `parseTopologyFile`'s internals still call `resolveNodeName(name)` for validation only and never use its return value, so this step alone doesn't compile cleanly against the *type* change yet. This is expected: Step 3 changes the signature and Step 4 changes the implementation together. (If your tooling insists on typechecking before running, skip straight to Step 3's type change before running this.)

- [ ] **Step 3: Write the new failing tests for alias expansion**

Add to `describe("parseTopologyFile", ...)`, after the existing `"resolves every node name mentioned, including nested ones"` test:

```ts
  it("expands an aliased name (a oneOf-desugared original) into all its shadows, as a parent", () => {
    const aliasing = (name: string): string[] => {
      if (name === "HandleFailed") return ["HandleFailed__Failed_Todo", "HandleFailed__Failed_Person"];
      return knownNames.has(name) ? [name] : (() => {
        throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
      })();
    };
    const wiring = parseTopologyFile(`HandleFailed:\n  then:\n    A: {}\n`, aliasing);
    expect(wiring.origins.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
    expect(wiring.feeds["HandleFailed__Failed_Todo"]).toEqual(["A"]);
    expect(wiring.feeds["HandleFailed__Failed_Person"]).toEqual(["A"]);
  });

  it("expands an aliased name into all its shadows, as a child", () => {
    const aliasing = (name: string): string[] => {
      if (name === "HandleFailed") return ["HandleFailed__Failed_Todo", "HandleFailed__Failed_Person"];
      return knownNames.has(name) ? [name] : (() => {
        throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
      })();
    };
    const wiring = parseTopologyFile(`A:\n  then:\n    HandleFailed: {}\n`, aliasing);
    expect(wiring.feeds.A?.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
  });
```

- [ ] **Step 4: Change `NodeNameResolver`'s type and `parseTopologyFile`'s implementation**

```ts
// elaborate.ts:264, before:
export type NodeNameResolver = (name: string) => void;
// after:
export type NodeNameResolver = (name: string) => string[];
```

```ts
// elaborate.ts:281-317, before:
export function parseTopologyFile(yamlText: string, resolveNodeName: NodeNameResolver): Wiring {
  const raw = (parse(yamlText) as Record<string, unknown> | null) ?? {};
  const origins: string[] = [];
  const feeds = new Map<string, Set<string>>();

  function walk(name: string, value: unknown): void {
    resolveNodeName(name);
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`"${name}": expected an object (optionally with "then"), got ${typeof value}.`);
    }
    const { then, ...rest } = value as { then?: unknown };
    const unrecognized = Object.keys(rest)[0];
    if (unrecognized !== undefined) {
      throw new Error(`"${name}": only "then" is a recognized key, got "${unrecognized}".`);
    }
    if (then === undefined) return;
    if (then === null || typeof then !== "object" || Array.isArray(then)) {
      throw new Error(`"${name}.then" must be a map of node names.`);
    }
    for (const [childName, childValue] of Object.entries(then)) {
      if (!feeds.has(name)) feeds.set(name, new Set());
      feeds.get(name)!.add(childName);
      walk(childName, childValue);
    }
  }

  for (const [name, value] of Object.entries(raw)) {
    origins.push(name);
    walk(name, value);
  }

  return {
    origins,
    feeds: Object.fromEntries([...feeds.entries()].map(([k, v]) => [k, [...v]])),
  };
}

// after:
export function parseTopologyFile(yamlText: string, resolveNodeName: NodeNameResolver): Wiring {
  const raw = (parse(yamlText) as Record<string, unknown> | null) ?? {};
  const origins: string[] = [];
  const feeds = new Map<string, Set<string>>();

  function walk(name: string, value: unknown): void {
    resolveNodeName(name);
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`"${name}": expected an object (optionally with "then"), got ${typeof value}.`);
    }
    const { then, ...rest } = value as { then?: unknown };
    const unrecognized = Object.keys(rest)[0];
    if (unrecognized !== undefined) {
      throw new Error(`"${name}": only "then" is a recognized key, got "${unrecognized}".`);
    }
    if (then === undefined) return;
    if (then === null || typeof then !== "object" || Array.isArray(then)) {
      throw new Error(`"${name}.then" must be a map of node names.`);
    }
    for (const [childName, childValue] of Object.entries(then)) {
      for (const parent of resolveNodeName(name)) {
        if (!feeds.has(parent)) feeds.set(parent, new Set());
        for (const child of resolveNodeName(childName)) feeds.get(parent)!.add(child);
      }
      walk(childName, childValue);
    }
  }

  for (const [name, value] of Object.entries(raw)) {
    origins.push(...resolveNodeName(name));
    walk(name, value);
  }

  return {
    origins,
    feeds: Object.fromEntries([...feeds.entries()].map(([k, v]) => [k, [...v]])),
  };
}
```

Update the function's doc comment (elaborate.ts:266-280) to add one sentence: `"A name that resolves to more than one real node (a oneOf-desugared original) expands to references to all of them, uniformly, whether it appears as a parent or a child — deliberately imprecise rather than smart, since a wasted readiness check on the wrong shadow is free (docs/superpowers/specs/2026-08-31-any-desugaring-design.md)."`

- [ ] **Step 5: Wire the alias map into `elaborate()`'s `resolveNodeName` construction**

First, capture the alias map from Task 3's loop:

```ts
// elaborate.ts, in the node-loading loop from Task 3, before:
  const nodes: Record<string, NodeDecl> = {};
  for (const [name, text] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown };
    const isOneOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "oneOf" in raw.input;
    if (isOneOf) {
      Object.assign(nodes, parseOneOfNodeFile(text, name, resolveEdge));
    } else {
      nodes[name] = parseNodeFile(text, name, resolveEdge);
    }
  }

// after:
  const nodes: Record<string, NodeDecl> = {};
  const oneOfAliases = new Map<string, string[]>();
  for (const [name, text] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown };
    const isOneOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "oneOf" in raw.input;
    if (isOneOf) {
      const shadows = parseOneOfNodeFile(text, name, resolveEdge);
      Object.assign(nodes, shadows);
      oneOfAliases.set(name, Object.keys(shadows));
    } else {
      nodes[name] = parseNodeFile(text, name, resolveEdge);
    }
  }
```

Then update `resolveNodeName`'s construction:

```ts
// elaborate.ts:430-434, before:
  const resolveNodeName: NodeNameResolver = (name) => {
    if (!(name in nodes)) {
      throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    }
  };

// after:
  const resolveNodeName: NodeNameResolver = (name) => {
    const aliased = oneOfAliases.get(name);
    if (aliased) return aliased;
    if (!(name in nodes)) {
      throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    }
    return [name];
  };
```

- [ ] **Step 6: Run to verify green**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/elaborate.test.ts`
Expected: clean typecheck, all tests PASS (all 10 pre-existing `parseTopologyFile` tests plus the 2 new alias-expansion ones).

Run: `npx vitest run` (full suite)
Expected: all PASS.

- [ ] **Step 7: Add one real, end-to-end `elaborate()`-level test proving the alias survives the full pipeline (not just the isolated `parseTopologyFile` unit)**

Add to the `describe("elaborate", ...)` block:

```ts
  it("lets a .topology file reference a oneOf-desugared node's original name, expanding to all shadows", async () => {
    const root = await writeFixture({
      "edges/Start.edge": `
description: A starting value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "nodes/failing.node": `
description: d
input: Start
output: Start
examples:
  - given:
      Start:
        value: "a"
    expect:
      Start:
        value: "a"
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  oneOf:
    - Failed_Todo
    - Failed_Person
output: Start
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Start:
        value: "a"
  - given:
      Failed_Person:
        input: "bad person"
    expect:
      Start:
        value: "a"
`,
      "topology/main.topology": `
failing:
  then:
    HandleFailed: {}
`,
    });

    const result = await elaborate(root);

    expect(result.wiring.feeds.failing?.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
  });
```

Run: `cd spikes/ts-prototype && npx vitest run src/elaborate.test.ts`
Expected: all PASS, including this new one.

- [ ] **Step 8: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/elaborate.test.ts
git commit -m "Let .topology reference a oneOf-desugared node's original name

resolveNodeName now returns the real underlying name(s) instead of just
validating - a reference to the original name expands to all its shadows,
uniformly, as either a then: parent or child."
```

---

## Task 5: `define.ts` — a TS-level helper for direct `oneOf` node construction

**Files:**
- Modify: `spikes/ts-prototype/src/define.ts`
- Modify: `spikes/ts-prototype/src/define.test.ts` (new tests)

**Interfaces:**
- Consumes: `AnyEdgeDef`, `OutputSpec`, `NodeDef`, `Fn` (existing types).
- Produces: `defineOneOfNodes(name, edges, output, fn): Record<string, NodeDef>` — the TS-level equivalent of what `elaborate.ts`'s `parseOneOfNodeFile` does for YAML, for tests/programmatic construction that bypasses `.node` files entirely (mirrors why `defineNode`/`every`/`single` etc. exist alongside the YAML path).

- [ ] **Step 1: Write the failing test**

Add to `define.test.ts` (find the existing `describe` structure for `single`/`every`/`allOf`/`oneOf` and add a sibling block):

```ts
describe("defineOneOfNodes", () => {
  const A = defineEdge({
    name: "A",
    label: "A",
    description: "Edge A",
    fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
  });
  const B = defineEdge({
    name: "B",
    label: "B",
    description: "Edge B",
    fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
  });
  const Out = defineEdge({
    name: "Out",
    label: "Out",
    description: "Edge Out",
    fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
  });

  it("builds one single-input NodeDef per edge, named <Name>__<Edge>, sharing one fn", () => {
    const nodes = defineOneOfNodes("Handle", [A, B], single(Out), (payload) => ({ value: payload.value }));

    expect(Object.keys(nodes).sort()).toEqual(["Handle__A", "Handle__B"]);
    expect(nodes.Handle__A!.input).toEqual({ kind: "single", edge: A });
    expect(nodes.Handle__A!.output).toEqual({ kind: "single", edge: Out });
    expect(nodes.Handle__B!.input).toEqual({ kind: "single", edge: B });
  });

  it("calls the shared fn with the bare, untagged payload for whichever edge it's for", async () => {
    const received: unknown[] = [];
    const nodes = defineOneOfNodes("Handle", [A, B], single(Out), (payload) => {
      received.push(payload);
      return { value: "x" };
    });

    await nodes.Handle__A!.fn({ value: "a" });
    expect(received).toEqual([{ value: "a" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/define.test.ts -t "defineOneOfNodes"`
Expected: FAIL — `defineOneOfNodes is not a function` (or a TS compile error if the harness typechecks test files; either way, fails for the right reason: it doesn't exist).

- [ ] **Step 3: Add `defineOneOfNodes` to `define.ts`**

Add after the existing `defineNode` function:

```ts
/**
 * The TS-level equivalent of `elaborate.ts`'s `parseOneOfNodeFile` — builds
 * N ordinary single-input `NodeDef`s, one per listed edge, named
 * `<name>__<edgeName>` (same double-underscore convention, for the same
 * reason: edge names can already contain single underscores). For direct
 * construction (tests, programmatic use) bypassing `.node` YAML entirely,
 * the same role `defineNode`/`single`/`every` already play relative to the
 * elaborator's YAML path.
 *
 * `fn` is shared across every shadow — each receives the bare, untagged
 * payload for its own edge only, never a runtime discriminant. A caller
 * wanting genuinely different logic per edge should call this once per edge
 * with a different `fn`, or call `defineNode` directly per shadow — this
 * helper only covers the shared-logic case.
 */
export function defineOneOfNodes<Es extends AnyEdgeDef[], O extends OutputSpec>(
  name: string,
  edges: Es,
  output: O,
  fn: (payload: PayloadOf<Es[number]>, env?: Envelope) => OutputResult<O> | Promise<OutputResult<O>>,
): Record<string, NodeDef<{ kind: "single"; edge: Es[number] }, O>> {
  const nodes: Record<string, NodeDef<{ kind: "single"; edge: Es[number] }, O>> = {};
  for (const edge of edges) {
    const shadowName = `${name}__${edge.name}`;
    nodes[shadowName] = defineNode({
      name: shadowName,
      input: { kind: "single", edge },
      output,
      fn: fn as NodeDef<{ kind: "single"; edge: typeof edge }, O>["fn"],
    });
  }
  return nodes;
}
```

Check the top of `define.ts` for existing imports of `PayloadOf`, `OutputResult`, `Envelope`, `NodeDef`, `OutputSpec` from `./types.js` — add any missing from that list to the existing `import type {...}` line rather than adding a new import statement.

- [ ] **Step 4: Run to verify green**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/define.test.ts`
Expected: clean, all PASS.

Run: `npx vitest run` (full suite)
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/define.ts spikes/ts-prototype/src/define.test.ts
git commit -m "Add defineOneOfNodes, the TS-level equivalent of parseOneOfNodeFile

For direct construction bypassing .node YAML - same role defineNode/
single/every already play for the YAML path, applied to the desugaring
elaborate.ts does for oneOf: input."
```

---

## Task 6: End-to-end runtime proof — desugared shadows fire, `Failed<In>` routes, semantics corrected

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.test.ts` (new tests)

**Interfaces:**
- Consumes: `defineOneOfNodes` (Task 5), `elaborate`/`parseTopologyFile` alias expansion (Task 4), `runNetlist` (existing, unchanged by this task — proving it needs no changes, same as `every`'s routing didn't need runtime.ts changes when it first landed).
- Produces: nothing new — this task is pure proof, no production code changes.

- [ ] **Step 1: Write the failing (well — these should actually pass immediately once written, since Tasks 1-5 already built everything they exercise; "RED" here means confirming they'd fail without those tasks, which we've already verified incrementally. Write them now as regression coverage for the full pipeline together.)**

Add to `runtime.test.ts`, near the existing `every`-input tests (after the "fires an every-input node..." style tests — use `grep -n "describe(\"runNetlist\"" runtime.test.ts` to confirm the enclosing describe block, then insert before its closing `});`):

```ts
  it("real: a oneOf-desugared shadow fires through the worklist via an aliased .topology reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    const root = await mkdtemp(join(tmpdir(), "weir-decl-"));
    try {
      await mkdir(join(root, "edges"), { recursive: true });
      await mkdir(join(root, "nodes"), { recursive: true });
      await mkdir(join(root, "topology"), { recursive: true });
      // Todo/Person exist so elaborate()'s unconditional synthesizeFailedEdges
      // auto-creates Failed_Todo/Failed_Person for us — hand-authoring those
      // edges directly would fight that mechanism and produce the wrong shape
      // ({input: <embedded Todo/Person>, reason}, not a bare scalar).
      await writeFile(
        join(root, "edges", "Todo.edge"),
        `description: d\nfields:\n  title:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "edges", "Person.edge"),
        `description: d\nfields:\n  name:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "edges", "Start.edge"),
        `description: d\nfields:\n  value:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "nodes", "failing.node"),
        `description: d\ninput: Todo\noutput: Todo\nexamples:\n  - given:\n      Todo:\n        title: "bad todo"\n    expect:\n      Todo:\n        title: "bad todo"\n`,
        "utf8",
      );
      await writeFile(
        join(root, "nodes", "HandleFailed.node"),
        `description: d\ninput:\n  oneOf:\n    - Failed_Todo\n    - Failed_Person\noutput: Start\nexamples:\n  - given:\n      Failed_Todo:\n        input:\n          title: "bad todo"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n  - given:\n      Failed_Person:\n        input:\n          name: "bad person"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n`,
        "utf8",
      );
      await writeFile(join(root, "topology", "main.topology"), `failing:\n  then:\n    HandleFailed: {}\n`, "utf8");

      const raw = await elaborate(root);
      // failing fails on Todo -> logs Failed_Todo, which HandleFailed__Failed_Todo
      // is listening for; HandleFailed__Failed_Person never becomes ready (nothing
      // ever logs Failed_Person) — proving the alias's "wasted, harmless attempt"
      // on the shadow that can't actually fire, not just the one that can.
      for (const [name, fn] of [
        ["failing", `export default function failing() { throw new Error("kaboom"); }`],
        ["HandleFailed__Failed_Todo", `export default function handle() { return { value: "recovered" }; }`],
        ["HandleFailed__Failed_Person", `export default function handle() { return { value: "recovered" }; }`],
      ] as const) {
        const hash = (await hashNode(raw.nodes[name]!)).short;
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, `${hash}.ts`), `${fn}\n`, "utf8");
      }

      const program = await elaborateWithImplementations(root, dir);
      const log = new InMemoryLog();

      await runNetlist(program, log, "thread-1", { failing: { title: "bad todo" } });

      expect(log.latest("Failed_Todo", "thread-1")).toEqual({ input: { title: "bad todo" }, reason: "kaboom" });
      expect(log.latest("Failed_Person", "thread-1")).toBeUndefined();
      expect(log.latest("Start", "thread-1")).toEqual({ value: "recovered" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("desugared shadows fire independently — no cross-shadow exclusivity, unlike the old any", async () => {
    const A = defineEdge({
      name: "A",
      label: "A",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const B = defineEdge({
      name: "B",
      label: "B",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const Out = defineEdge({
      name: "Out",
      label: "Out",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    // A side-effect counter, not the shared Out edge's log state, proves both
    // fired: InMemoryLog.latest() only keeps the most recent write, so two
    // firings to the same edge would be indistinguishable from "only one
    // fired" by log state alone. defineOneOfNodes shares one `output` across
    // every shadow (same as parseOneOfNodeFile's .node YAML equivalent), so
    // there's no way to give each shadow its own output edge to tell them
    // apart that way either — the counter is the real, unambiguous proof.
    const received: string[] = [];
    const shadows = defineOneOfNodes("Handle", [A, B], single(Out), (payload) => {
      received.push(payload.value);
      return { value: payload.value };
    });
    // Both listed as origins with real originPayloads, not pre-logged edges
    // read via log.latest — runNetlist requires an origin's payload to come
    // from originPayloads (it returns false early otherwise, never touching
    // the log), so this is the correct way to seed two independent origins
    // in one worklist run, not a simplification of the real scenario.
    const program = programWith(shadows, { origins: ["Handle__A", "Handle__B"], feeds: {} });
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", { Handle__A: { value: "a" }, Handle__B: { value: "b" } });

    expect(received.sort()).toEqual(["a", "b"]);
  });
```

- [ ] **Step 2: Run to verify both pass**

Run: `cd spikes/ts-prototype && npx vitest run src/runtime.test.ts`
Expected: all PASS, including both new tests.

Check the imports at the top of `runtime.test.ts` include `defineOneOfNodes` from `./define.js` and `elaborateWithImplementations` from `./implementation.js` (the second is already imported per the file's existing "real: AddTodoToList..." test) — add `defineOneOfNodes` to the existing `import { ... } from "./define.js";` line if missing.

- [ ] **Step 3: Full suite and typecheck**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/runtime.test.ts
git commit -m "Prove oneOf desugaring end-to-end: fires via aliased topology, Failed<In> routes for free, no cross-shadow exclusivity

Closes the loop the spec opened: any-input Failed<In> routing is no
longer a gap, because there's no any-input node left to route for -
every former any-node's failure already goes through the existing
single-input mechanism."
```

---

## Task 7: Rename `every` → `allOf` (pure rename, no behavior change)

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts:237-239,251,256-257` — Note: line numbers will have shifted from Task 1's edits; use `grep -n '"every"' types.ts` to relocate before editing.
- Modify: `spikes/ts-prototype/src/define.ts:180-189` (delete `every()` entirely)
- Modify: `spikes/ts-prototype/src/membrane.ts` (`EveryInvoke` → `AllOfInvoke`, the `kind === "every"` check, `AnyEveryInvoke` stays as-is in `runtime.ts` — see below)
- Modify: `spikes/ts-prototype/src/runtime.ts` (the `kind === "every"` check in `Failed<In>` routing; `AnyEveryInvoke` → `AnyAllOfInvoke`)
- Modify: `spikes/ts-prototype/src/elaborate.ts` (`resolveInputSpec`'s `"every" in input` branch; `everyCombosByKey` → `allOfCombosByKey`; `synthesizeEveryFailedEdges` → `synthesizeAllOfFailedEdges`)
- Modify: `spikes/ts-prototype/src/types.ts` (`failedEveryEdgeName` → `failedAllOfEdgeName`)
- Modify: `spikes/ts-prototype/src/schema.ts:266-271,323-327` (rename `every` conditional/key to `allOf`)
- Modify: `spikes/ts-prototype/src/hash.ts:156-157,171-172` (`InputSpecFingerprint`'s `every` branch, `fingerprintInput`'s matching return)
- Modify: `spikes/ts-prototype/src/membrane.test.ts`, `elaborate.test.ts`, `runtime.test.ts`, `schema.test.ts`, `hash.test.ts` (every reference to `every`/`EveryInvoke`/`failedEveryEdgeName` renamed to `allOf`/`AllOfInvoke`/`failedAllOfEdgeName`)
- Modify: `examples/todo-list/src/nodes/AddTodoToList.node` (`every:` → `allOf:`)
- Modify: `schemas/node.schema.json` (regenerated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `InputSpec` is `{kind:"single"} | {kind:"allOf"}`. `every` no longer exists anywhere — as a `kind` string, an exported function, a type name substring, or a YAML keyword. Behavior is byte-for-byte identical to before this task; only names changed.

This is a single atomic task because the rename is a closed-type-union change — partial renaming across files won't compile. Work through the files in dependency order (types first, since everything else imports from it), typecheck after each file, and don't run the full suite until the last step (intermediate states won't compile cleanly).

- [ ] **Step 1: `types.ts`**

```ts
// InputSpec, before:
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "every"; edges: AnyEdgeDef[] };
// after:
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "allOf"; edges: AnyEdgeDef[] };
```

```ts
// InputPayload, before:
  : I extends { kind: "every"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
    : never;
// after:
  : I extends { kind: "allOf"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
    : never;
```

Rename `failedEveryEdgeName` → `failedAllOfEdgeName` (its doc comment, function name, and internal logic are unchanged — only the name):

```ts
// before:
export function failedEveryEdgeName(edges: AnyEdgeDef[]): string {
  const sortedNames = edges.map((edge) => edge.name).sort();
  return `Failed_${sortedNames.join("_")}`;
}
// after:
export function failedAllOfEdgeName(edges: AnyEdgeDef[]): string {
  const sortedNames = edges.map((edge) => edge.name).sort();
  return `Failed_${sortedNames.join("_")}`;
}
```

(The synthesized edge *name itself* — `Failed_A_B` — is derived from the edge names A/B, not from the word "every"/"allOf", so no test assertion checking for `Failed_A_B` or `Failed_Todo_TodoList` needs to change.)

Update every doc comment in `types.ts` mentioning `every` to say `allOf` instead (there are several — search `grep -n "every" types.ts` after the code changes above and fix remaining prose references).

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: many errors — this is fine mid-rename, keep going.

- [ ] **Step 2: `define.ts`**

```ts
// before:
/**
 * A multi-input readiness condition (docs/design.md §5): fires once every
 * listed edge type has appeared for the current correlation_id, not a
 * synchronous join. Distinct from `allOf` — `allOf` is an output fan-out
 * (several edges fire from one node), `every` is an input fan-in (several
 * edges must already exist before one node can fire).
 */
export function every<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "every"; edges: Es } {
  return { kind: "every", edges };
}
```

Delete this function entirely — confirmed in the spec that `allOf<Es>(...edges): {kind:"allOf"; edges: Es}` (a few lines below, already exists for `OutputSpec`) is structurally identical to what the input side needs. Update `allOf`'s own doc comment to note the dual role:

```ts
// before:
/** Product (fission): every listed edge fires. */
export function allOf<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "allOf"; edges: Es } {
  return { kind: "allOf", edges };
}
// after:
/**
 * Product: every listed edge fires. Shared between input and output
 * positions, same as `single` already is — as an output, "every listed
 * edge fires from this node" (fission); as an input, "every listed edge
 * must already exist before this node can fire" (fan-in, a readiness
 * check against a correlation_id's logs, not a synchronous join). The
 * structural shape is identical either way, so one function serves both.
 */
export function allOf<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "allOf"; edges: Es } {
  return { kind: "allOf", edges };
}
```

Run: `npm run typecheck` — expect continued errors elsewhere, fine.

- [ ] **Step 3: `membrane.ts`**

Rename the `EveryInvoke` type to `AllOfInvoke` (its doc comment, signature, and body logic are unchanged — search-and-replace the identifier `EveryInvoke` → `AllOfInvoke` throughout the file, and `every`-input → `allOf`-input in its doc comment). Rename the `MembraneInvoke` discriminant's `kind: "every"` check to `kind: "allOf"`. Rename the `if (nodeDef.input.kind === "every")` branch condition to `"allOf"` (its body is unchanged). Update the file header comment's `"Covers \`single\` and \`every\` InputSpecs"` to `"Covers \`single\` and \`allOf\` InputSpecs"`.

Run: `npm run typecheck` — continued errors elsewhere, fine.

- [ ] **Step 4: `runtime.ts`**

Rename `AnyEveryInvoke` (from Task 1) → `AnyAllOfInvoke` throughout. Rename the `else if (nodeDef.input.kind === "every")` check (in the `Failed<In>` routing block) to `"allOf"`. Rename `failedEveryEdgeName` call to `failedAllOfEdgeName`. Update the file header's `Failed<In>` routing bullet's mention of `every`-input to `allOf`-input.

Run: `npm run typecheck` — continued errors elsewhere, fine.

- [ ] **Step 5: `elaborate.ts`**

```ts
// resolveInputSpec, before:
  if (input !== null && typeof input === "object" && "every" in input) {
    return { kind: "every", edges: resolveEdgeNameList(input.every, "input.every", resolveEdge) };
  }
// after:
  if (input !== null && typeof input === "object" && "allOf" in input) {
    return { kind: "allOf", edges: resolveEdgeNameList(input.allOf, "input.allOf", resolveEdge) };
  }
```

Rename `synthesizeEveryFailedEdges` → `synthesizeAllOfFailedEdges` (function name and its call site only — body unchanged, still calls `failedAllOfEdgeName` per Step 1's rename). Rename the pre-scan's `everyCombosByKey` variable → `allOfCombosByKey`, and its inner check `"every" in raw.input` / `raw.input.every` → `"allOf" in raw.input` / `raw.input.allOf`. Update every doc comment mentioning `every:` YAML syntax or the `every` combo mechanism to say `allOf:`/`allOf` instead (`synthesizeFailedEdges`'s comment mentioning "every-input combos get their own synthesis", the pre-scan's comment, `parseNodeFile`'s `resolveInputSpec` doc comment).

Run: `npm run typecheck` — continued errors elsewhere, fine.

- [ ] **Step 6: `schema.ts`**

```ts
// before:
    // every: several edges must all be present, each tagged by name in given
    // (docs/design-history.md, "`every` lands") — mirrors allOf's expect shape.
    {
      if: { properties: { input: { type: "object", required: ["every"] } } },
      then: { properties: { examples: { items: { properties: { given: tagged(objectPayload) } } } } },
    },
// after:
    // allOf (input position): several edges must all be present, each
    // tagged by name in given — mirrors allOf's own expect shape on the
    // output side.
    {
      if: { properties: { input: { type: "object", required: ["allOf"] } } },
      then: { properties: { examples: { items: { properties: { given: tagged(objectPayload) } } } } },
    },
```

```ts
// before:
          {
            type: "object",
            properties: { every: edgeNameList },
            required: ["every"],
            additionalProperties: false,
          },
// after:
          {
            type: "object",
            properties: { allOf: edgeNameList },
            required: ["allOf"],
            additionalProperties: false,
          },
```

Run: `npm run typecheck` — continued errors in test files only at this point, fine.

- [ ] **Step 7: `hash.ts`**

```ts
// InputSpecFingerprint, before:
type InputSpecFingerprint =
  | { kind: "single"; edge: EdgeFingerprint }
  | { kind: "every"; edges: EdgeFingerprint[] };
// after:
type InputSpecFingerprint =
  | { kind: "single"; edge: EdgeFingerprint }
  | { kind: "allOf"; edges: EdgeFingerprint[] };
```

```ts
// fingerprintInput, before:
function fingerprintInput(input: InputSpec): InputSpecFingerprint {
  if (input.kind === "single") return { kind: "single", edge: fingerprint(input.edge) };
  return { kind: "every", edges: fingerprintEdgeList(input.edges) };
}
// after:
function fingerprintInput(input: InputSpec): InputSpecFingerprint {
  if (input.kind === "single") return { kind: "single", edge: fingerprint(input.edge) };
  return { kind: "allOf", edges: fingerprintEdgeList(input.edges) };
}
```

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: errors only in `*.test.ts` files now (all production code renamed).

- [ ] **Step 8: Update every real `.node` file**

```yaml
# examples/todo-list/src/nodes/AddTodoToList.node, before:
input:
  every:
    - TodoList
    - Todo
# after:
input:
  allOf:
    - TodoList
    - Todo
```

- [ ] **Step 9: Update the test files — structural rename via `sed`, description-string rename by exact list**

The structural parts of this rename (imports, `every(` calls, `"every"`/`every:` keys, the five renamed identifiers) are truly 1:1 mechanical and safe to `sed`. Test *description strings* are not — "every" appears in some of them as ordinary English ("resolves **every** node name mentioned") and in others as a reference to the feature being renamed ("routes an **every**-input node's failure") — a blind substitution would silently produce grammatically-broken descriptions for the former. Handle these as two separate steps per file.

**9a. Structural rename, one `sed` invocation per file** (macOS `sed -i ''`; use `sed -i` without the empty string on Linux):

```bash
cd spikes/ts-prototype/src
for f in membrane.test.ts runtime.test.ts elaborate.test.ts schema.test.ts hash.test.ts; do
  sed -i '' \
    -e 's/, every, single } from "\.\/define\.js"/, allOf, single } from ".\/define.js"/' \
    -e 's/\bevery(/allOf(/g' \
    -e 's/"every"/"allOf"/g' \
    -e 's/every:/allOf:/g' \
    -e 's/AnyEveryInvoke/AnyAllOfInvoke/g' \
    -e 's/EveryInvoke/AllOfInvoke/g' \
    -e 's/failedEveryEdgeName/failedAllOfEdgeName/g' \
    -e 's/everyCombosByKey/allOfCombosByKey/g' \
    -e 's/synthesizeEveryFailedEdges/synthesizeAllOfFailedEdges/g' \
    "$f"
done
```

(`\bevery(` only matches the function-call form — `every(A, B)`, not the English word, since it requires an immediately-following `(` with no space. This is safe against every occurrence found in this plan's research; if `npm run typecheck` afterward still shows a stray `every` reference as a compile error, that's a location this pattern missed — fix it directly, it means a new occurrence was introduced since this plan was written.)

**9b. Test description strings — exact list, apply each by hand (`sed` is deliberately not used here — see above):**

| File:line (pre-rename) | Old text | New text |
|---|---|---|
| `membrane.test.ts:335` | `describe("membrane — every", () => {` | `describe("membrane — allOf", () => {` |
| `membrane.test.ts:347` | `it("calls fn once every declared edge is present, keyed by edge name", async () => {` | `it("calls fn once all declared edges are present, keyed by edge name", async () => {` |
| `membrane.test.ts:522` | `it("gives every-input nodes a real Envelope the same way", async () => {` | `it("gives allOf-input nodes a real Envelope the same way", async () => {` |
| `schema.test.ts:452` | `it("accepts an every input with a multi-tag given", () => {` | `it("accepts an allOf input with a multi-tag given", () => {` |
| `schema.test.ts:469` | `it("rejects an every input whose given has no tags", () => {` | `it("rejects an allOf input whose given has no tags", () => {` |
| `elaborate.test.ts:295` | `it("resolves an every: input into multiple edges, in declared order", () => {` | `it("resolves an allOf: input into multiple edges, in declared order", () => {` |
| `elaborate.test.ts:578` | `it("synthesizes a Failed_<A>_<B> edge for a declared every: combo, sorted and order-independent", async () => {` | `it("synthesizes a Failed_<A>_<B> edge for a declared allOf: combo, sorted and order-independent", async () => {` |
| `elaborate.test.ts:783` | `it("loads the real todo-list example — proving every: input resolves against real hand-authored files", async () => {` | `it("loads the real todo-list example — proving allOf: input resolves against real hand-authored files", async () => {` |
| `runtime.test.ts:251` | `it("routes an every-input node's failure to the sorted-name combo edge, order-independent", async () => {` | `it("routes an allOf-input node's failure to the sorted-name combo edge, order-independent", async () => {` |
| `runtime.test.ts:534` | `it("real: AddTodoToList fails on a malformed Todo — every-input Failed<In> routes to Failed_Todo_TodoList", async () => {` | `it("real: AddTodoToList fails on a malformed Todo — allOf-input Failed<In> routes to Failed_Todo_TodoList", async () => {` |
| `hash.test.ts:386` | `it("is independent of every: edge declaration order", async () => {` | `it("is independent of allOf: edge declaration order", async () => {` |

(Line numbers are pre-rename, from this plan's research — re-locate with `grep -n` if Tasks 1-6's edits shifted them.)

**Explicitly do NOT touch these — legitimate, unrelated English usage of the word "every", confirmed during this plan's research, not an oversight:**
- `membrane.test.ts:74` `"lists every violation in Failed<In>.reason, not just the first"`
- `membrane.test.ts:266` `"accepts a payload satisfying every validation"`
- `elaborate.test.ts:465` `"resolves every node name mentioned, including nested ones"`
- `elaborate.test.ts:558` `"synthesizes a Failed_<EdgeName> edge for every declared edge"` (single-input synthesis, unrelated to the `every`/`allOf` `InputSpec` kind)
- `runtime.test.ts:403` `"routes an allOf output — logs every tagged branch"` (already-correct *output*-side `allOf`; "every tagged branch" here is English, not the renamed kind)
- `runtime.ts:93` `keys.every((key) => ...)` (Array.prototype.every, unrelated)

Run after finishing each file: `cd spikes/ts-prototype && npx vitest run src/<file>.test.ts` — fix anything red before moving to the next file.

- [ ] **Step 10: Full typecheck and full suite**

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean — zero references to `every` as a `kind`, type, or function remain anywhere in `src/`.

Run: `npx vitest run`
Expected: all PASS, same total test count as before this task (pure rename, no tests added or removed).

Run: `grep -rn '"every"\|\bevery(' src/` (from `spikes/ts-prototype/`) — confirm the only remaining hits are the legitimate, unrelated uses of the English word "every" (`keys.every(...)` in `runtime.ts`, test names like `"resolves every node name mentioned"`, `"lists every violation"`, `"accepts a payload satisfying every validation"`).

- [ ] **Step 11: Regenerate schemas, check the diff**

Run: `cd spikes/ts-prototype && npm run generate:schemas`
Expected: `schemas/node.schema.json` changes — `every` becomes `allOf` in the `input.oneOf` list and its conditional's `required` array. Confirm via `git diff schemas/node.schema.json` from repo root that only this key rename appears.

- [ ] **Step 12: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/ examples/todo-list/src/nodes/AddTodoToList.node schemas/node.schema.json
git commit -m "Rename every -> allOf, completing the input/output naming symmetry

Pure rename per docs/superpowers/specs/2026-08-31-any-desugaring-design.md's
folded-in section - every() deleted outright rather than renamed, since
the existing output allOf() is already structurally identical (same
pattern single() already uses across both positions). No behavior change:
same readiness check, same bag payload shape, same Failed_A_B routing."
```

---

## Task 8: Docs — design-history.md entry, open-questions.md cleanup

**Files:**
- Modify: `docs/design-history.md`
- Modify: `docs/open-questions.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Append a new `docs/design-history.md` entry**

Read the tail of `docs/design-history.md` first (`tail -5 docs/design-history.md`) to match its exact prose style and confirm what the last entry is, then append (matching the file's established voice — dense, cross-referenced, judgment calls stated as judgment calls):

```markdown

## `any` comes back out: it was never a runtime primitive, just sugar wearing one — and `every` becomes `allOf` to match

Built in `6d2558c`, `any` gave `Fn` a `{edge, payload}` tag and a real `AnyInvoke`/`membrane()` branch for the first of several distinct edges to arrive. Working through a concrete use case — `any(Bird, Turtle, Dog) -> Animal`, a widening node — surfaced that the tag was never load-bearing: decomposed into `WidenBird: single(Bird) -> Animal`, `WidenTurtle: single(Turtle) -> Animal`, `WidenDog: single(Dog) -> Animal`, each node is fully typed with no runtime discriminant, closer to "no ambient dispatch" than a single `Fn` internally branching on a string tag. `elaborate()` now desugars a `.node` file's `input: {oneOf: [...]}` into N ordinary single-input `NodeDecl`s at parse time (`parseOneOfNodeFile`), named `<Name>__<EdgeName>` (double underscore — edge names already contain single underscores, `Failed_Todo_TodoList`), never surviving into the runtime `InputSpec` union at all.

**Renamed `any` to `oneOf`, not kept and not renamed to `first`.** `any` collides with TypeScript's own `any` — homonymy, not a real semantic relationship. `first` was floated and dropped: it implies exclusivity ("the winner"), which doesn't match the real desugared behavior (next paragraph). `oneOf` won as `oneOf`'s own dual on the input side — `single` already proves "same word, different mechanism by position" is a pattern this project is comfortable with, and `output: oneOf: [Pass, Fail]` was already real YAML before this change (`examples/person-birthday`).

**A real behavior change surfaced along the way, not just a rename.** The old `any` was one node with one `fired` entry — first edge to arrive wins, the other is silently ignored forever if it later shows up too. Desugared into N separate nodes, each tracked in `fired` independently, both fire if both edges genuinely occur in one invocation. This is a correction, not an accepted regression: the old behavior silently dropped a real failure if two distinct `Failed_*` edges both occurred. An exclusive "first wins" primitive, if ever genuinely needed, is separate, new work — not preserved here.

**`.topology` needed a real mechanism, not just a naming change, to keep the original name writable.** `runtime.ts`'s worklist only attempts a node when something pushes it via `wiring.feeds` — never a periodic scan — so a desugared shadow needs `.topology` to reference it, directly or aliased, or it never fires even once its input is logged. `NodeNameResolver` changed from `(name) => void` (validate-or-throw) to `(name) => string[]` (resolve-and-expand); a `.topology` reference to the original name — as either a `then:` parent or a child — expands to all its shadows uniformly. Deliberately imprecise: a shadow gets redundantly checked from a parent that could never actually produce its edge, and that's fine — `tryFire`'s own readiness check and the `fired` set make a wasted attempt free.

**Also resolved the `any`-input `Failed<In>` gap this same work had deferred** (`c9d3676`: "any-input `Failed<In>`... still collects in `failures`, unrouted") — for free, not as separate work: after desugaring, every former `any`-node is an ordinary single-input node, and its failures already route through the mechanism built for that case.

**A real, previously-unnoticed bug surfaced and closed along with the primitive:** `hash.ts`'s `fingerprintInput` had no `any` case and silently mis-fingerprinted an `any`-input node as `every`. Moot now — no node ever carries a tagged-union input kind to mis-fingerprint.

**`every` becomes `allOf`, completing the symmetry — pure rename, no behavior change.** `every` (input) and `allOf` (output) already meant the same thing; `allOf`'s own doc comment was always "every listed edge fires." They carried different names purely by build order — `every` existed before `oneOf`/`allOf` did as output kinds to mirror. `single`↔`single`, `oneOf`↔`oneOf`, now `allOf`↔`allOf`. `define.ts`'s `every()` was deleted outright rather than renamed: confirmed the existing output `allOf()` is already structurally identical to what the input side needs, so both positions share one function, same as `single` already does.

**Two other rename candidates were tried and rejected for colliding with weir's own vocabulary, not just external ones.** `spread` is already load-bearing for `.edge` field-map composition (design.md §2) and already the candidate name for a different open question (`open-questions.md`, "partial input, partial node-pinned default") — reusing it a third way would have been worse than the collision it was meant to avoid. `poly` collides softer, with weir's existing parametric-generics "polymorphism" (`Animal<T>`) — a different kind of polymorphism than "several unrelated concrete types."

Full design at `docs/superpowers/specs/2026-08-31-any-desugaring-design.md`.
```

- [ ] **Step 2: Remove the now-resolved `open-questions.md` entry**

Find and delete the `"Is \`any\` actually the right name..."` bullet entirely (added in an earlier session on the same date) — the question is resolved (yes, and further: it's not a runtime kind at all anymore), not just answered, so it doesn't belong as an open question or even as a closed one there — `design-history.md`'s new entry above is its permanent record.

- [ ] **Step 3: Commit**

```bash
cd /Users/jordan/code/weir
date
git add docs/design-history.md docs/open-questions.md
git commit -m "Document the any-removal and every->allOf rename in design-history

Resolves and removes the 'is any the right name' open question - answered,
and superseded by removing any as a runtime kind entirely."
```

---

## Final verification (after all 8 tasks)

- [ ] Run `cd spikes/ts-prototype && npm run typecheck && npx vitest run` one final time — clean and fully green.
- [ ] Run `git log --oneline -10` from repo root — confirm 8 new commits, one per task, none amended or squashed.
- [ ] Run `git diff schemas/` from repo root against the state before Task 1 (`git diff 9da1f5f -- schemas/`) — confirm only the `any`→`oneOf` and `every`→`allOf` key renames appear, nothing else changed in the generated schemas.
