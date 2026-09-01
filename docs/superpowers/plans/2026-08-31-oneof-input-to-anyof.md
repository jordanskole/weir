# Input `oneOf` → `anyOf` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename weir's *input*-position `oneOf` (built earlier the same day as elaboration-time desugaring sugar for `any`'s replacement) to `anyOf` — its output-position sibling stays `oneOf`, unchanged. Pure identifier rename; the desugaring mechanism, `.topology` alias expansion, and firing behavior are all untouched.

**Architecture:** Input `oneOf` never became a runtime `InputSpec` kind — it's pure elaboration-time sugar recognized only in `elaborate.ts`'s node-loading loop and `parseOneOfNodeFile`, plus its TS-level equivalent `defineOneOfNodes` in `define.ts`, plus the authoring-level JSON-Schema validation in `schema.ts`. None of `types.ts`, `membrane.ts`, `runtime.ts`, or `hash.ts` ever recognized it. So this rename touches a strict subset of the files the `every`→`allOf` rename touched, and is correspondingly smaller.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest, `npm run typecheck` (`tsc --noEmit`).

**Spec:** `docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md` — this plan implements it in full. Read the spec's Motivation section (the resolved naming matrix) before Task 1.

## Global Constraints

- All work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- No `Co-Authored-By: Claude` trailer on any commit.
- Commit after each task, one task per commit.
- Check `date` before each commit; if it falls between 9am and 5pm on a weekday local time, use `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible evening time the same day instead — this is a personal-project convention. If the real time is already outside that window, commit normally.
- **Do not touch output-position `oneOf` anywhere** — `types.ts`'s `OutputSpec`, `OutputResult`, `membrane.ts`, `hash.ts`'s `OutputSpecFingerprint`, `define.ts`'s output `oneOf()` helper, `schema.ts`'s output-position conditional/property entries, `elaborate.ts`'s `resolveOutputSpec`, and every test exercising output `oneOf` (e.g. `elaborate.test.ts`'s "resolves a oneOf output...", `node.test.ts`'s "types a oneOf node...", `runtime.test.ts`'s output-`oneOf` routing tests) are all correctly named already and must not change.
- **Do not touch `nodeSchema()`'s own native JSON-Schema `oneOf` combinator usages** in `schema.ts` (the `oneOf: [...]` alternative-shape lists used to express "this property matches one of several JSON shapes," e.g. at the top of `properties.input`/`properties.output`, and inside `fieldSchema()`) — that's JSON Schema's own keyword, unrelated to weir's semantic property, and renaming it would break the schema.
- Regenerate `schemas/node.schema.json` (`npm run generate:schemas` from `spikes/ts-prototype/`) wherever `schema.ts` changes, and check the diff.

---

## Task 1: Rename the desugaring mechanism — `elaborate.ts` + `define.ts` and their tests

**Files:**
- Modify: `spikes/ts-prototype/src/elaborate.ts` (`parseOneOfNodeFile` → `parseAnyOfNodeFile`; the `isOneOf` detection variable and its `"oneOf" in raw.input` check → `isAnyOf`/`"anyOf" in raw.input`; `oneOfAliases` → `anyOfAliases`; doc comments)
- Modify: `spikes/ts-prototype/src/define.ts` (`defineOneOfNodes` → `defineAnyOfNodes`; doc comment)
- Modify: `spikes/ts-prototype/src/elaborate.test.ts` (rename the 5 tests that reference input `oneOf`: 2 in the `parseTopologyFile` alias-expansion describe block, 3 in the `elaborate` describe block)
- Modify: `spikes/ts-prototype/src/define.test.ts` (rename the `describe("defineOneOfNodes", ...)` block and its 2 tests' use of the identifier)

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseAnyOfNodeFile`, `anyOfAliases` (both private to `elaborate.ts`), `defineAnyOfNodes` (exported from `define.ts`, used directly by Task 3's `runtime.test.ts` work — no production code beyond this task needs it). `elaborate()`'s `nodes` record and `.topology` alias behavior are byte-identical to before this task; only names changed.

- [ ] **Step 1: `elaborate.ts` — rename `parseOneOfNodeFile` and its doc comment**

```ts
// Before (elaborate.ts, the doc comment + function signature):
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

// After:
/**
 * Parses a `.node` file whose `input` is `{ anyOf: [...] }` into N separate
 * `NodeDecl`s, one per listed edge — desugaring sugar, not a real
 * `InputSpec` kind (docs/superpowers/specs/2026-08-31-any-desugaring-design.md,
 * docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md). Named
 * `<name>__<edgeName>`, double underscore (edge names can already contain
 * single underscores, e.g. `Failed_Todo_TodoList`, so a single underscore
 * join would be ambiguous to a human reading the name).
 *
 * Each example in the original file's `examples` array is routed to the one
 * shadow whose edge name appears as its `given`'s tag key (schema.ts's
 * `taggedOne` already guarantees exactly one tag per example at the
 * authoring level). A shadow with no matching examples gets no `examples`
 * key at all — the same "examples optional" looseness `parseNodeFile`
 * already has, not a new gap this introduces.
 */
function parseAnyOfNodeFile(
  yamlText: string,
  name: string,
  resolveEdge: EdgeResolver,
): Record<string, NodeDecl> {
```

Inside the function body, two more references need updating:

```ts
// Before:
    input?: { oneOf: unknown };
    // ...
  const edges = resolveEdgeNameList(input?.oneOf, "input.oneOf", resolveEdge);

// After:
    input?: { anyOf: unknown };
    // ...
  const edges = resolveEdgeNameList(input?.anyOf, "input.anyOf", resolveEdge);
```

Everything else in the function body (the `name`/`fn` guards, the shadow-building loop, the `<name>__<edgeName>` naming, the example-filtering) is unchanged — do not touch it.

- [ ] **Step 2: `elaborate.ts` — rename the detection check and alias map in `elaborate()`'s node-loading loop**

```ts
// Before:
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

  const resolveNodeName: NodeNameResolver = (name) => {
    const aliased = oneOfAliases.get(name);
    if (aliased) return aliased;
    if (!(name in nodes)) {
      throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    }
    return [name];
  };

// After:
  const nodes: Record<string, NodeDecl> = {};
  const anyOfAliases = new Map<string, string[]>();
  for (const [name, text] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown };
    const isAnyOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "anyOf" in raw.input;
    if (isAnyOf) {
      const shadows = parseAnyOfNodeFile(text, name, resolveEdge);
      Object.assign(nodes, shadows);
      anyOfAliases.set(name, Object.keys(shadows));
    } else {
      nodes[name] = parseNodeFile(text, name, resolveEdge);
    }
  }

  const resolveNodeName: NodeNameResolver = (name) => {
    const aliased = anyOfAliases.get(name);
    if (aliased) return aliased;
    if (!(name in nodes)) {
      throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    }
    return [name];
  };
```

- [ ] **Step 3: `define.ts` — rename `defineOneOfNodes`**

```ts
// Before:
/**
 * The TS-level equivalent of `elaborate.ts`'s `parseOneOfNodeFile` — builds
 * N ordinary single-input `NodeDef`s, one per listed edge, named
 * `<name>__<edgeName>` (same double-underscore convention, for the same
 * reason: edge names can already contain single underscores). For direct
 * construction (tests, programmatic use) bypassing `.node` YAML entirely,
 * the same role `defineNode`/`single`/`allOf` already play relative to the
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

// After:
/**
 * The TS-level equivalent of `elaborate.ts`'s `parseAnyOfNodeFile` — builds
 * N ordinary single-input `NodeDef`s, one per listed edge, named
 * `<name>__<edgeName>` (same double-underscore convention, for the same
 * reason: edge names can already contain single underscores). For direct
 * construction (tests, programmatic use) bypassing `.node` YAML entirely,
 * the same role `defineNode`/`single`/`allOf` already play relative to the
 * elaborator's YAML path.
 *
 * `fn` is shared across every shadow — each receives the bare, untagged
 * payload for its own edge only, never a runtime discriminant. A caller
 * wanting genuinely different logic per edge should call this once per edge
 * with a different `fn`, or call `defineNode` directly per shadow — this
 * helper only covers the shared-logic case.
 */
export function defineAnyOfNodes<Es extends AnyEdgeDef[], O extends OutputSpec>(
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

- [ ] **Step 4: `elaborate.test.ts` — rename the two `parseTopologyFile` alias-expansion test names (bodies unchanged, no literal "oneOf" string inside them — only the descriptions name the concept)**

```ts
// Before:
  it("expands an aliased name (a oneOf-desugared original) into all its shadows, as a parent", () => {

// After:
  it("expands an aliased name (an anyOf-desugared original) into all its shadows, as a parent", () => {
```

(The second test, `"expands an aliased name into all its shadows, as a child"`, doesn't mention `oneOf` at all — leave it untouched.)

- [ ] **Step 5: `elaborate.test.ts` — rename the three `elaborate` describe-block tests exercising input `oneOf`**

```ts
// Before:
  it("desugars a oneOf: input into N single-input NodeDecls, named <Node>__<Edge>", async () => {

// After:
  it("desugars an anyOf: input into N single-input NodeDecls, named <Node>__<Edge>", async () => {
```

Inside that same test's fixture YAML, rename the `.node` file's `input:` block:

```yaml
# Before:
input:
  oneOf:
    - Failed_Todo
    - Failed_Person

# After:
input:
  anyOf:
    - Failed_Todo
    - Failed_Person
```

Second test:

```ts
// Before:
  it("gives a oneOf-desugared shadow no examples key when none of the file's examples tag its edge", async () => {

// After:
  it("gives an anyOf-desugared shadow no examples key when none of the file's examples tag its edge", async () => {
```

Same fixture YAML rename inside it (`input: { oneOf: [...] }` → `input: { anyOf: [...] }`, same YAML block shape as the first test).

Third test (in the same describe block, further down — search for it, it references `.topology` aliasing against a real `elaborate()` call):

```ts
// Before:
  it("lets a .topology file reference a oneOf-desugared node's original name, expanding to all shadows", async () => {

// After:
  it("lets a .topology file reference an anyOf-desugared node's original name, expanding to all shadows", async () => {
```

This test also has a `.node` fixture with `input:\n  oneOf:\n    - Failed_Todo\n    - Failed_Person\n` (or equivalent multi-line YAML) — rename that `oneOf:` key to `anyOf:` the same way.

- [ ] **Step 6: `define.test.ts` — rename the `defineOneOfNodes` describe block and its two tests' calls**

```ts
// Before:
describe("defineOneOfNodes", () => {
  // ... (A, B, Out edge fixtures, unchanged)

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

// After:
describe("defineAnyOfNodes", () => {
  // ... (A, B, Out edge fixtures, unchanged)

  it("builds one single-input NodeDef per edge, named <Name>__<Edge>, sharing one fn", () => {
    const nodes = defineAnyOfNodes("Handle", [A, B], single(Out), (payload) => ({ value: payload.value }));

    expect(Object.keys(nodes).sort()).toEqual(["Handle__A", "Handle__B"]);
    expect(nodes.Handle__A!.input).toEqual({ kind: "single", edge: A });
    expect(nodes.Handle__A!.output).toEqual({ kind: "single", edge: Out });
    expect(nodes.Handle__B!.input).toEqual({ kind: "single", edge: B });
  });

  it("calls the shared fn with the bare, untagged payload for whichever edge it's for", async () => {
    const received: unknown[] = [];
    const nodes = defineAnyOfNodes("Handle", [A, B], single(Out), (payload) => {
      received.push(payload);
      return { value: "x" };
    });

    await nodes.Handle__A!.fn({ value: "a" });
    expect(received).toEqual([{ value: "a" }]);
  });
});
```

- [ ] **Step 7: Typecheck and full suite**

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

Run: `npx vitest run`
Expected: all 249 tests PASS (same count — pure rename, nothing added or removed).

- [ ] **Step 8: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/elaborate.ts spikes/ts-prototype/src/define.ts \
  spikes/ts-prototype/src/elaborate.test.ts spikes/ts-prototype/src/define.test.ts
git commit -m "Rename input oneOf to anyOf in the desugaring mechanism

parseOneOfNodeFile -> parseAnyOfNodeFile, oneOfAliases -> anyOfAliases,
defineOneOfNodes -> defineAnyOfNodes. Per docs/superpowers/specs/
2026-08-31-oneof-input-becomes-anyof.md - pure rename, output oneOf
untouched."
```

---

## Task 2: Rename the authoring-level JSON-Schema validation — `schema.ts`

**Files:**
- Modify: `spikes/ts-prototype/src/schema.ts` (the input-position `oneOf` conditional and property entry only)
- Modify: `spikes/ts-prototype/src/schema.test.ts` (the 3 tests exercising input `oneOf`)
- Modify: `schemas/node.schema.json` (regenerated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `nodeSchema()` accepts `.node` YAML with `input: {anyOf: [...]}` instead of `input: {oneOf: [...]}`. `input: {oneOf: [...]}` is no longer valid authoring syntax after this task — an editor validating against the regenerated schema will reject it. The output-position `oneOf` schema (unaffected) still accepts `output: {oneOf: [...]}`.

- [ ] **Step 1: Update the 3 `schema.test.ts` tests, watch them fail**

```ts
// Before:
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

// After:
  it("accepts an anyOf input with a single-tag given", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: { Todo: { title: "Buy milk" } }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an anyOf input whose given has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: {}, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

  it("rejects an anyOf input whose given has more than one tag", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
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

Run: `cd spikes/ts-prototype && npx vitest run src/schema.test.ts -t "anyOf input"`
Expected: FAIL — `nodeSchema()` doesn't recognize `anyOf` on `input` yet (the accept case fails; the reject cases may pass vacuously for the wrong reason, since `additionalProperties: false` combined with an unrecognized required key still rejects — the accept case is the one that proves the shape is actually recognized).

- [ ] **Step 2: `schema.ts` — rename the input-position `oneOf` conditional**

```ts
// Before:
    // oneOf (input position): exactly one of several declared edges arrives,
    // tagged by name in given — mirrors oneOf's own expect shape on the
    // output side (docs/superpowers/specs/2026-08-31-any-desugaring-design.md).
    // Desugars into N single-input nodes at elaboration time (elaborate.ts);
    // this only validates the authoring-level YAML shape.
    {
      if: { properties: { input: { type: "object", required: ["oneOf"] } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },

// After:
    // anyOf (input position): one or more of several declared edges may
    // arrive, each independently — NOT the same "exactly one" guarantee
    // output's oneOf carries (docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md).
    // Each individual example still tags exactly one edge, since it
    // demonstrates one shadow's behavior at a time — that's what taggedOne
    // below checks, unchanged from before this rename. Desugars into N
    // single-input nodes at elaboration time (elaborate.ts); this only
    // validates the authoring-level YAML shape.
    {
      if: { properties: { input: { type: "object", required: ["anyOf"] } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },
```

**Do not touch** the output-position `oneOf` conditional immediately below this one in the same `outputShapeConditionals` array (`if: { properties: { output: { type: "object", required: ["oneOf"] } } }`) — that stays exactly as-is.

- [ ] **Step 3: `schema.ts` — rename the input-position `oneOf` property entry**

```ts
// Before:
      input: {
        oneOf: [
          edgeName,
          {
            type: "object",
            properties: { allOf: edgeNameList },
            required: ["allOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { oneOf: edgeNameList },
            required: ["oneOf"],
            additionalProperties: false,
          },
        ],
      },

// After:
      input: {
        oneOf: [
          edgeName,
          {
            type: "object",
            properties: { allOf: edgeNameList },
            required: ["allOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { anyOf: edgeNameList },
            required: ["anyOf"],
            additionalProperties: false,
          },
        ],
      },
```

Note: the outer `oneOf: [...]` here (the one wrapping `edgeName`/the `allOf`-object/the now-`anyOf`-object as three alternatives) is JSON Schema's own native combinator ("input must match exactly one of these three shapes") — it stays as the literal word `oneOf`, unrenamed. Only the inner `properties: { oneOf: edgeNameList }, required: ["oneOf"]` (weir's own property key) becomes `anyOf`.

**Do not touch** the `output: { oneOf: [...] }` block immediately below this one — it has an identical-looking `{type: "object", properties: {oneOf: edgeNameList}, required: ["oneOf"], additionalProperties: false}` entry, but that one is output's real `oneOf` and must stay named `oneOf`.

- [ ] **Step 4: Typecheck, run schema tests, regenerate schemas, check the diff**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/schema.test.ts`
Expected: both clean/green.

Run: `npm run generate:schemas`
Expected: `schemas/node.schema.json` changes — the input-position `oneOf` key becomes `anyOf` in exactly two places (the `properties.input.oneOf` list's third alternative's `properties`/`required`, and the corresponding `if`/`required` conditional). The output-position `oneOf` entries are unchanged. Confirm via `git diff schemas/node.schema.json` from repo root that only this rename appears.

Run: `npx vitest run` (full suite)
Expected: all 249 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/schema.ts spikes/ts-prototype/src/schema.test.ts schemas/node.schema.json
git commit -m "Rename input oneOf to anyOf in nodeSchema()'s authoring-level validation

Output oneOf, and nodeSchema()'s own native JSON-Schema oneOf combinator
usages, are untouched."
```

---

## Task 3: Rename in `runtime.test.ts` (test-only — `runtime.ts` never knew about input `oneOf`)

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.test.ts` (one test name, one YAML fixture string)

**Interfaces:**
- Consumes: `elaborate()`'s renamed `anyOf`-desugaring behavior from Task 1 (this test exercises it end-to-end via real `.node`/`.topology` fixture files).
- Produces: nothing new — no production code in `runtime.ts` is touched, confirming (again) that the rename never needed to reach it.

- [ ] **Step 1: Rename the test name and its YAML fixture's `oneOf:` key**

```ts
// Before:
  it("real: a oneOf-desugared shadow fires through the worklist via an aliased .topology reference", async () => {

// After:
  it("real: an anyOf-desugared shadow fires through the worklist via an aliased .topology reference", async () => {
```

Inside that same test, one of the `writeFile` calls writes a `.node` file's raw YAML text as an inline template-literal string:

```ts
// Before (inside the writeFile call for "nodes/HandleFailed.node" — the string contains literal \n YAML):
        `description: d\ninput:\n  oneOf:\n    - Failed_Todo\n    - Failed_Person\noutput: Start\nexamples:\n  - given:\n      Failed_Todo:\n        input:\n          title: "bad todo"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n  - given:\n      Failed_Person:\n        input:\n          name: "bad person"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n`,

// After (only "oneOf" -> "anyOf" changes, nothing else in the string):
        `description: d\ninput:\n  anyOf:\n    - Failed_Todo\n    - Failed_Person\noutput: Start\nexamples:\n  - given:\n      Failed_Todo:\n        input:\n          title: "bad todo"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n  - given:\n      Failed_Person:\n        input:\n          name: "bad person"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n`,
```

Nothing else in this test changes — the comment above it (`// failing fails on Todo -> logs Failed_Todo, which HandleFailed__Failed_Todo is listening for...`) is already accurate and doesn't mention "oneOf" by name, so it needs no edit.

- [ ] **Step 2: Typecheck and full suite**

Run: `cd spikes/ts-prototype && npm run typecheck && npx vitest run src/runtime.test.ts`
Expected: clean, all PASS.

Run: `npx vitest run` (full suite)
Expected: all 249 PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/jordan/code/weir
date
git add spikes/ts-prototype/src/runtime.test.ts
git commit -m "Rename oneOf to anyOf in the end-to-end desugaring integration test

Test-only change - runtime.ts itself never recognized input oneOf/anyOf,
confirming (again) the rename never needed to reach the runtime layer."
```

---

## Task 4: Docs — `design-history.md` entry

**Files:**
- Modify: `docs/design-history.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Append a new entry**

Read the tail of `docs/design-history.md` first (`tail -5 docs/design-history.md`) to confirm it ends with the "`any` comes back out... `every` becomes `allOf`" entry from earlier the same day, then append (matching the file's established voice):

```markdown

## Input `oneOf` corrected to `anyOf`, same day as the rename that introduced it

Spot-checked independently — a second conversation, working from the same repo state, reached the same conclusion without seeing this file. Output `oneOf` (`types.ts`'s `OutputSpec`, untouched by any of today's work) is a real coproduct: `OutputResult` for that kind is a union type, `Fn` returns one value, so the type system guarantees exactly one branch every call — matching JSON Schema's own `oneOf` keyword ("exactly one subschema validates"), which `schema.ts` already uses natively elsewhere in the same file. Input `oneOf` (built earlier today, "`any` comes back out," this file) does not carry that guarantee: it desugars into N independent single-input nodes with no cross-shadow exclusivity, by deliberate design — if two listed edges both occur in one invocation, both shadows fire. The group produces zero, one, or up to N firings, never a guaranteed one. That's JSON Schema's `anyOf` ("one or more validate"), not its `oneOf`.

**Traced to one sentence in that entry's own reasoning:** "`oneOf` won: it's `oneOf`'s own dual on the input side (a coproduct — exactly one of several concrete types is relevant per firing)." "Per firing" is true of any individual shadow in isolation — each shadow's own input genuinely is exactly one edge type — but the analogy was drawn at the wrong grain: it doesn't hold for the group across firings, which is the property that actually matters for the word "coproduct" to apply.

**Resolved naming matrix**, settled directly:

| | input | output |
|---|---|---|
| `allOf` | all must be present | all fire |
| `anyOf` | one or more may fire, independently | — |
| `oneOf` | — | exactly one fires |

`allOf` stays genuinely dual, same as `single` — one word, one meaning, either position. `anyOf` and `oneOf` are not: each is single-position only after this correction, and deliberately so — there is no coherent "output anyOf" (`Fn` returns exactly one value per call, so "zero or more of these may fire" has no output-side meaning the way it does for independent input-side node firings), so none was built.

**Pure rename, smaller in scope than `every`→`allOf` or the `any`→`oneOf` desugaring itself** — full spec at `docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md`. `parseOneOfNodeFile`→`parseAnyOfNodeFile`, `defineOneOfNodes`→`defineAnyOfNodes`, `oneOfAliases`→`anyOfAliases`, `schema.ts`'s input-position conditional/property key. Never touched `types.ts`, `membrane.ts`, `runtime.ts`, or `hash.ts` — input `oneOf` never became a runtime `InputSpec` kind in the first place, so none of them ever knew its name to begin with.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/jordan/code/weir
date
git add docs/design-history.md
git commit -m "Document the input oneOf -> anyOf naming correction in design-history"
```

---

## Final verification (after all 4 tasks)

- [ ] Run `cd spikes/ts-prototype && npm run typecheck && npx vitest run` one final time — clean and fully green, 249 tests.
- [ ] Run `git log --oneline -5` from repo root — confirm 4 new commits, one per task, none amended or squashed.
- [ ] Run `grep -rn '"oneOf"\|\boneOf(' spikes/ts-prototype/src/` from repo root — every remaining hit should be output-position `oneOf` (a real, correctly-named `OutputSpec`/`OutputResult` reference, an `oneOf()` output-helper call, a `describe`/`it` about output `oneOf`, or `nodeSchema()`'s own native JSON-Schema `oneOf` combinator) or a doc-comment citation of a design-history.md entry title. Zero hits should describe input-position behavior.
- [ ] Run `grep -n "oneOf" docs/design.md docs/open-questions.md` from repo root — the spec (`docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md`) predicted zero hits in either file, since neither ever documented input-`oneOf` syntax before this correction (it didn't exist until the same day it was renamed). Confirm that prediction rather than assuming it — if either file has a real hit describing input-`oneOf` as current syntax, that's a plan gap: fix it the same way `docs/design.md`/`docs/open-questions.md` were fixed for the `every`→`allOf` rename (a prior, separate fix wave), not by silently ignoring it.
- [ ] Run `git diff <plan-start-commit> -- schemas/` from repo root — confirm only the input-`oneOf`→`anyOf` key rename appears in `schemas/node.schema.json`, nothing else changed.
