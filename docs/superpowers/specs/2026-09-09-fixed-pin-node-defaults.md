# `closure` renamed to `fixed`; a third shape, `pin`, for node-pinned input defaults

Status: approved design, not yet implemented.

## Motivation

**The rename.** `closure` (`.node`'s optional key for values baked in at elaboration time — an origin's whole output via `literal`, an `expect` node's whole comparison value via `expected`) borrows only the verb from the general-programming sense of "closure" (a function closing over a free variable in its enclosing scope) and drops everything else that makes a closure a closure: there is no function value here, no deferred invocation, no captured environment. `examples/person-birthday/README.md`'s own decision 4 already flags this as improvised, not derived from the design docs: "closure as the general mechanism for baked-in parameters... this is the one part of the file that's more invention than transcription." Surfaced independently in this conversation by a reader with a standard CS background finding the name actively misleading. `fixed` says what's actually true — these values are fixed, not caller-supplied — without importing a function-value connotation nothing here has.

**The `pin` shape.** `open-questions.md`'s "Partial input, partial node-pinned default" item: `examples/todo-list/src/nodes/CreateTodo.node` declares `input: Todo`, which forces a caller to supply every field of `Todo`, including `is_complete` — semantically backwards, since whether a freshly created todo is already complete isn't the caller's decision, it's always `false`. The existing `literal` *field* kind (`edge CompletedTodo { ...Todo, is_complete: true }`) doesn't fix this: it pins a field for the lifetime of a distinct, nominally-different edge, but `Todo.is_complete` must stay a real mutable bool (`CompleteTodo.node` flips it later on the same edge) — pinning it at the edge level would break that. What's missing is a node-scoped pin: *this particular node* doesn't take `is_complete` from its caller, regardless of what `Todo` allows in general. `closure`/`fixed` already existed for "baked in at elaboration time"; it just only supported all-or-nothing (`literal` bakes a whole output, `expected` bakes a whole input). `pin` is the partial case: some of an input edge's fields, node-pinned, the rest still caller-supplied.

## Design

### 1. `closure` → `fixed`, everywhere

Pure rename — key name, TS type names, doc comments. No shape or behavior change to the existing `expected`/`literal` kinds.

- `types.ts`: `NodeDef.closure?: ExpectClosure<In> | LiteralClosure<O>` → `NodeDef.fixed?: ExpectFixed<In> | LiteralFixed<O> | PinFixed<In>` (the third member is new, §2 below). `ExpectClosure`/`LiteralClosure` → `ExpectFixed`/`LiteralFixed`.
- `schema.ts`: `nodeSchema()`'s `closure` property → `fixed` (see §2 for its new third `oneOf` branch). Doc comment at `nodeSchema()` ("name/input/output/examples/closure") updated to say `fixed`.
- `elaborate.ts`: both `parseNodeFile` and `parseAnyOfNodeFile`'s destructured `closure` → `fixed`; `NodeDecl["closure"]` casts → `NodeDecl["fixed"]`.
- `hash.ts`: `NodeFingerprint.closure?: unknown` → `NodeFingerprint.fixed?: unknown`; `fingerprintNode`'s `node.closure` → `node.fixed`. Doc comment above `NodeFingerprint` ("`closure` is included: a baked-in literal...") updated to also name `pin` — a node-pinned default changes what the implementation must actually compute (it now owns producing that field), same reasoning as the existing two kinds.
- `netlist.ts`: `NetlistNode.closure?: unknown` → `fixed`; `serializeNode`'s `node.closure` → `node.fixed`.
- Test files (`schema.test.ts`, `elaborate.test.ts` — check for closure-referencing cases —, `hash.test.ts`, `netlist.test.ts`, `node.test.ts`): rename every `closure`-referring test name, YAML string, and JSON payload to `fixed`.
- `schemas/node.schema.json`: regenerate via `npm run generate:schemas`; diff should show the `closure`→`fixed` key rename plus the new `pin` branch (§2).
- `examples/person-birthday/netlist.json`, `examples/person-birthday/src/nodes/expect_Person_age_42.node`: `closure:` → `fixed:`, values unchanged.
- `examples/person-birthday/README.md`, `examples/recipe/README.md`: prose mentions of "closure"/"closure-literal"/"closure-origin" updated to "fixed".
- `docs/design.md` (§10, "name, input, output, examples, closure" and "resolves closures and monomorphizes generics"): updated to "fixed" / "resolves fixed values and monomorphizes generics".
- `docs/design-history.md`: one new entry recording the rename (what it replaces, why, that a reader flagged the metaphor as misleading, pointer to this spec) — its *historical* mentions of `closure` (the entries documenting how `closure`/`literal`/`expected` were originally decided) stay as written, same convention the `oneOf`→`anyOf` rename spec used for its own history.
- **Untouched**: `docs/superpowers/plans/2026-08-31-oneof-desugaring-and-allof-rename.md` — a past plan document, historical record, not live documentation.
- `docs/open-questions.md`: the "Partial input, partial node-pinned default" item is removed entirely (resolved, not just renamed — see §3).

### 2. `fixed.pin`: node-scoped partial input defaults

New third shape, sibling to `expected`/`literal`, same mutual-exclusivity discipline (exactly one of the three per node — enforced the same way `expected`/`literal` already are, via `nodeSchema()`'s `oneOf`, not a `kind`/`method` tag field: see the "Why not a tag field" note below).

```ts
type PinFixed<In extends InputSpec> = In extends { kind: "single" }
  ? { pin: Partial<InputPayload<In>> }
  : never;
```

- **Scope**: `single`-kind input only. `allOf`/`anyOf` input stays out of scope for `pin` — a natural but undesigned extension, same treatment the `literal` field kind itself got when it shipped boolean-only.
- **Value scope**: `pin`'s keys must name real fields of the input edge; values are scalars only (bool/string/number) — no nested-edge or `many` fields. This is what requires generalizing the `literal` **field kind** (`schema.ts`'s `literalFieldShape()`, currently `{ literal: boolean }` used by `.edge` files like `CompletedTodo { ...Todo, is_complete: true }`) to `{ literal: boolean | string | number }`. Two independent "literal" mechanisms share a name and both get touched here: the field kind (generalized) and `fixed.literal` (renamed, unchanged in shape) — worth flagging during implementation so they aren't conflated.
- **Caller-facing intent, not a schema-enforced one**: an author omits every field named in `pin` from `given`, and gives `expect` a value matching the declared `pin` for that field — but nothing checks this mechanically. Confirmed while writing the implementation plan: `nodeSchema()`'s `given`/`expect` payload schema (`objectPayload = { type: "object" }`) accepts any object today, for every node — no field is required, none is forbidden, and this is true for ordinary fields too, not just pinned ones. Even `expected`/`literal`'s existing edge-name tagging is explicitly never cross-checked against a real declared edge at the schema layer (`tagged()`'s own doc comment: "real name-matching stays the elaborator's job"). Building payload-shape validation just for `pin`, while every other field on every other node stays unchecked, would be new, disproportionate scope — not a small extension of existing enforcement. `pin` stays exactly as declarative as `expected`/`literal` already are: the convention is real and worth following, but caught by review and (once a real `Fn`/property-based testing pipeline exists, §6) by examples failing to pass — the same trust model already governing the rest of this file format, not a stronger one invented for this one mechanism.
- **`Fn`'s type is unchanged.** `InputPayload<In>` still reflects the full input edge — `pin` doesn't narrow what `Fn` receives or is typed to return; `Fn` is responsible for actually producing the pinned value(s) in whatever it returns. No runtime injection/merge is built here either, for the same reason: `expected`/`literal` get none today.
- **What *is* schema-checked**: the shape of `pin` itself — its keys are non-empty strings, its values are scalars (see `nodeSchema()`'s new branch below). Whether those keys actually name real fields of the input edge, and whether `given`/`expect` actually honor them, is not — consistent with every other cross-file/cross-field check in this codebase being the elaborator's job or not yet built at all.

**Why not a `method:`/`kind:` discriminant tag** (considered and rejected during design): `fixed: { method: "pin", is_complete: false }` was proposed as an alternative to nesting under `pin:`. Rejected for two concrete reasons, not just style: (1) namespace collision — `method` would sit in the same object as the actual pinned field names, so an edge with a field literally called `method` couldn't be pinned without a key clash; nesting keeps the discriminant and the data in disjoint namespaces, always. (2) `fixed.pin`'s value is exactly `Partial<InputPayload<In>>` and can be handed to any consumer as-is; a sibling `method` tag would need to be filtered out first, everywhere `fixed` is read. This also keeps `pin` consistent with `input`/`output`'s own established idiom in this file format — one field, alternative shapes, presence of the shape's key is the discriminant, no separate `kind:` property (`docs/design-history.md`, on `.node`'s output shape).

**`schema.ts`'s `nodeSchema()`**, `fixed`'s `oneOf` gains a third branch:

```ts
{
  type: "object",
  properties: { pin: { type: "object", minProperties: 1, additionalProperties: { type: ["boolean", "string", "number"] } } },
  required: ["pin"],
  additionalProperties: false,
}
```

(Field-name-against-input-edge validation — checking `pin`'s keys are real fields of the declared input edge — needs cross-file information the same way `tagged()`'s edge-name-tag validation already does not attempt at the schema layer; that check belongs to the elaborator, per the existing precedent noted in `tagged()`'s own doc comment.)

### 3. `CreateTodo.node`, concrete result

```yaml
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

Same edge (`Todo`) on both `input` and `output` — no `TodoDraft`/`NewTodo` proliferation.

## Explicitly out of scope

- Runtime auto-merge/injection of pinned values — declarative and example-checked only, matching `expected`/`literal`'s current level of enforcement.
- `pin` on `allOf`/`anyOf`-kind input.
- Pinning nested-edge or `many` fields.
- Generalizing `literal` past scalars (e.g. to nested-edge or `many` fields) — only bool→{bool,string,number} is in scope, matching the concrete need.
- The `id`-supplied-by-caller question visible in the same `CreateTodo` example (should a node mint its own identity rather than accept one from the caller) — real, but a separate, undecided question, not this one.
