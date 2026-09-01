# `any` becomes `oneOf`: authoring sugar over single-input nodes, not a runtime primitive

Status: approved design, not yet implemented.
Supersedes: parts of `6d2558c` ("Build any as InputSpec's coproduct-shaped sibling to every"), which built `any` as a real runtime `InputSpec` kind.

## Motivation

`any(A, B)` was built as a fourth `InputSpec` kind alongside `single`/`every`: a readiness check satisfied by the first of several distinct declared edges to arrive, with `Fn` receiving a `{edge, payload}` tag so it knows which one fired.

Working through a concrete use case (`any(Bird, Turtle, Dog) -> Animal`, a widening/declassifying node) surfaced that this doesn't need to be a runtime primitive at all:

- A plain single-input node already "just runs on input" — there's no extra waiting semantics `any` adds beyond what `single` already has, once you notice `any(A, B)` is really two independent readiness checks, not one joint one.
- Decomposed into `WidenBird: single(Bird) -> Animal`, `WidenTurtle: single(Turtle) -> Animal`, `WidenDog: single(Dog) -> Animal`, each node is fully typed with no runtime discriminant — closer to weir's "no ambient dispatch" ethos than a single `Fn` that internally branches on a string tag.
- It resolves the `any`-input `Failed<In>` routing gap (deferred in `c9d3676`) for free: after desugaring, every former `any`-node is an ordinary single-input node, and its `Failed<In>` already routes through the mechanism built for the single-input case.
- It surfaced a real, previously-unnoticed bug: `hash.ts`'s `fingerprintInput` has no `any` case and silently mis-fingerprints an `any`-input node as `every`. This disappears along with the primitive rather than needing its own fix.

The ergonomic win of writing one block instead of hand-authoring N node files is preserved as authoring-time sugar — it just doesn't survive into the runtime `InputSpec` union.

**Renamed to `oneOf`, not kept as `any` or renamed to `first`.** `any` collides with TypeScript's own `any` (homonymy — same spelling, unrelated meaning, not a real semantic relationship). `first` was considered and dropped: it implies exclusivity ("the winner"), which turns out not to match the real desugared behavior (next section). Two other candidates were tried and rejected for colliding with *weir's own* vocabulary: `spread` is already load-bearing for `.edge` field-map composition (design.md §2, `edge Parrot { ...Animal, wingspan }`) and is already the candidate name for a *different* open question (`open-questions.md`, "partial input, partial node-pinned default") — reusing it a third way was worse than the TS collision it was meant to avoid. `poly` collides softer, but really, with weir's existing parametric-generics "polymorphism" (`Animal<T>`, bounded polymorphism) — a different kind of polymorphism than "several unrelated concrete types." `oneOf` won: it's `oneOf`'s own dual on the input side (a coproduct — exactly one of several concrete types is relevant per firing), reuses vocabulary already load-bearing for exactly this logical relationship on the output side, and costs nothing new to learn — `single` already proves "same word, different concrete mechanism depending on input/output position" is a pattern this project is comfortable with. It's also already a real visual pattern in hand-authored YAML today, not a new one: `examples/person-birthday/src/nodes/expect_Person_age_42.node` already has `output: oneOf: [Pass, Fail]`.

**A real behavior change, not just a rename — surfaced by working through the naming question, and worth stating plainly.** Today, `any(A, B)` is *one* node with *one* entry in `runtime.ts`'s `fired` set: whichever edge arrives first, it fires once and is done — if the *other* declared edge later shows up too, in the same invocation, it's silently ignored forever. Desugared into `HandleFailed__Failed_Todo` and `HandleFailed__Failed_Person`, each is tracked in `fired` *separately* — so if both edges genuinely occur in one invocation, **both shadows fire independently.** There is no cross-shadow exclusivity after this change; "first wins, closes the door" is gone, replaced by "each fires on its own, whenever its own edge shows up." This is a deliberate improvement, not an accepted regression: under today's `any`, if both `Failed_Todo` and `Failed_Person` occur, one of them is silently never handled — real, unintentional data loss, an artifact of `any` being implemented as one node with one `fired` flag rather than a chosen requirement. If exclusive "first wins" behavior is ever genuinely needed, that's a distinct, separate future primitive — explicitly out of scope here (see below), not something this design tries to preserve.

## What's removed

- `types.ts`: the `{kind: "any"; edges: AnyEdgeDef[]}` member of `InputSpec`, and its `InputPayload` conditional branch.
- `membrane.ts`: `AnyInvoke`, the `any`-branch of `membrane()`, the `MembraneInvoke` discriminant's `any` case.
- `runtime.ts`: `AnyMultiInvoke` collapses back to whatever single non-`single` case remains (just `every`'s call shape) if nothing else needs the generic alias; the `any`-input branch of the `Failed<In>` routing `if`/`else if`/`else` (currently the `else` — unrouted, pushed to `failures`) goes away entirely, since no node ever reaches the runtime with `kind: "any"` after desugaring.
- `elaborate.ts`: the `{any: [...]}` recognition branch inside `resolveInputSpec` (replaced by a `{oneOf: [...]}` recognition branch that desugars — see below, not simply deleted).
- `define.ts`: the `any(...edges)` helper (replaced by a different-shaped helper — see below).
- `hash.ts`: no change needed — the latent any-mis-fingerprints-as-every bug is moot once no node ever carries `kind: "any"`.

**Small, not zero, change to `schema.ts`.** `nodeSchema()`'s `any`-shape conditional and its `properties.input.oneOf` list entry both need their literal key renamed from `any` to `oneOf` (`required: ["any"]` → `required: ["oneOf"]`, etc.) to match the renamed YAML keyword — the *shape* of the validation (still `taggedOne`, still exactly one tag per example) doesn't change, just the key it's keyed on. Worth naming precisely because it's easy to assume this collapses to "no change" the way the rest of the schema-layer reasoning does — it doesn't, quite. (Weir's own `nodeSchema()` will end up with JSON Schema's own `oneOf` combinator keyword nested around a *weir* `oneOf` property key, on both `input` and `output` now instead of just `output` — already-shipped, already-working precedent from the original output-`oneOf` work, not a new risk.)

## What's added

### `elaborate.ts`: desugaring at `.node`-parse time

A `.node` file whose `input` is `{oneOf: [...]}` no longer produces one `NodeDecl` with `kind: "any"`. Instead, parsing it produces **N separate `NodeDecl`s**, one per listed edge:

```
HandleFailed.node:
  input: {oneOf: [Failed_Todo, Failed_Person]}
  output: Recovered
```

expands to two entries in `elaborate()`'s `nodes` record:

- `HandleFailed__Failed_Todo`: `{name: "HandleFailed__Failed_Todo", input: {kind: "single", edge: Failed_Todo}, output: <same>, examples: <see below>}`
- `HandleFailed__Failed_Person`: `{name: "HandleFailed__Failed_Person", input: {kind: "single", edge: Failed_Person}, output: <same>, examples: <see below>}`

The original name (`HandleFailed`) is **not** a real key in `nodes` after desugaring — it only survives as an alias (below).

**Naming convention:** `<OriginalName>__<EdgeName>`, double underscore. Chosen over a single underscore because edge names can already contain underscores (`Failed_Todo_TodoList` already exists as a real synthesized edge), so a single-underscore join would be ambiguous to a human reading a node name, even though nothing actually needs to parse it back apart programmatically.

**Examples:** a `.node` file's `examples` block, under the `{oneOf: [...]}` input YAML shape, tags each example by which edge it's demonstrating (mirroring how `oneOf`'s `expect` is already tagged on the output side today) — `given: {Failed_Todo: {...}}` for one example, `given: {Failed_Person: {...}}` for another. Splitting examples across the desugared shadows means each shadow only gets the examples tagged for its own edge. Confirmed (not assumed): `parseNodeFile`'s own `NodeDecl` construction treats `examples` as optional (`examples?: unknown`, included only if present) — it does not itself enforce non-empty, that enforcement lives one layer up, in `schema.ts`'s JSON-schema validation of the *original, pre-desugared* `.node` YAML shape. So a shadow ending up with zero matching examples after the split is not a new failure mode this design introduces; it inherits the same already-existing, already-accepted gap any hand-authored single-input node with an empty `examples` list already has today (nothing currently cross-checks that every declared `oneOf`/`every` edge is demonstrated at least once). No new handling needed.

### `.topology`: a name-alias map keeps the original name writable

`runtime.ts`'s worklist only ever attempts a node when something pushes it onto the queue via `wiring.feeds` (or it's a declared origin) — it is not a periodic fixed-point scan of every node. So for a desugared shadow to ever fire, `.topology` has to reference it, directly or through an alias, or it silently never gets attempted even once its input is logged.

`elaborate()` carries forward a `Map<string, string[]>` (original name → its shadow names) produced by the desugaring step. `parseTopologyFile`'s `resolveNodeName` (and whatever builds the final `Wiring.feeds`/`Wiring.origins`) consults this map: a `.topology` reference to `HandleFailed` — whether as a `then:` parent or a child — expands to references to **all** of `HandleFailed`'s shadows, uniformly.

This is deliberately imprecise rather than smart: a `.topology` entry like

```
SomeNodeThatConsumesTodo:
  then:
    HandleFailed: {}
```

expands `feeds["SomeNodeThatConsumesTodo"]` to include both `HandleFailed__Failed_Todo` and `HandleFailed__Failed_Person`, even though `SomeNodeThatConsumesTodo` firing can only ever actually produce `Failed_Todo`, never `Failed_Person`. The redundant shadow gets pushed onto the worklist and attempted, finds its own declared edge absent from the log, and `tryFire` returns `false` — a wasted check, not a correctness problem (idempotent via the existing `fired` set, no side effects from a failed readiness check, and consistent with the "each fires independently" semantics above — nothing here tries to reintroduce exclusivity). No per-edge dependency analysis needed to avoid this; it's not worth building given the worklist model already makes a wasted attempt free of consequence.

### `define.ts`: a different-shaped TS-level helper

The removed `any(...edges)` returned an `InputSpec` fragment, the same shape `single`/`every`/`oneOf`/`allOf` all return. Since desugaring produces *N* `NodeDef`s rather than one `InputSpec`, its replacement is not a drop-in — it needs to return something like `Record<string, NodeDef>` (or accept a name and return that record keyed by the same `<Name>__<EdgeName>` convention `elaborate.ts` uses, for consistency between the YAML path and direct TS-level construction used in tests).

**Left open for the implementation plan:** the exact signature and name (`defineOneOfNodes`? something else — TBD at plan time, not a placeholder left carelessly, just genuinely secondary to the mechanism). A plausible shape:

```ts
function defineOneOfNodes<Es extends AnyEdgeDef[]>(
  name: string,
  edges: Es,
  output: OutputSpec,
  fn: Fn<...> | Record<Es[number]["name"], Fn<...>>, // one shared fn, or one per edge
): Record<string, NodeDef>
```

but the shared-vs-per-edge `fn` ergonomics (a single function vs. a map keyed by edge name) should be settled against how the existing test suite actually wants to construct these, not decided in the abstract here.

### Implementation resolution: unchanged

No changes to `hash.ts` or `implementation.ts`. Each desugared shadow is an ordinary named node with its own contract hash, resolved by the existing `{node-name}/{hash}.ts` convention. Two shadows that want to share logic do so the ordinary way — both `.ts` files `export default` the same imported function from a shared module. Two shadows whose logic genuinely differs each get their own real implementation. This is a deliberate non-decision: no new sharing mechanism, because ordinary module reuse already covers it.

## Test / doc impact

- Removed: `membrane.test.ts`'s `describe("membrane — any", ...)` block (8 tests), the `any`-specific input-resolution test in `elaborate.test.ts` (it asserted `{kind: "any", edges: [...]}` — replaced, not just deleted, by the desugaring tests below), `runtime.test.ts`'s `any`-specific tests (fires-on-first, still-collects-in-failures — the latter is also just factually superseded, since the new behavior isn't "fires on first" anymore, see Motivation).
- Renamed, not removed: `schema.test.ts`'s `any`-shape accept/reject tests — same coverage, same `taggedOne` shape, just asserting against `{oneOf: [...]}` instead of `{any: [...]}`.
- Added: `elaborate.test.ts` coverage for the desugaring itself (one `.node` file → N `NodeDecl`s, correct naming, correct per-edge example splitting), for `.topology`'s alias expansion (a reference to the original name resolves to all shadows, both as parent and child), and for the corrected semantics (both shadows fire independently when both edges occur in one invocation — a real behavior-change test, not just a renamed one). `runtime.test.ts` coverage proving a desugared shadow actually fires end-to-end through the worklist via an aliased `.topology` reference, and that `Failed<In>` for a desugared shadow routes through the existing single-input mechanism with no new code.
- `docs/design-history.md` gets a new entry documenting the reversal — what `any` was as a runtime primitive, why it came out, the naming path to `oneOf` (including the rejected candidates and why), and the semantics correction. `docs/open-questions.md`'s "Is `any` actually the right name..." entry gets resolved/removed (the question dissolves along with the primitive it was about naming).

## Also folded in: `every` becomes `allOf`

Completing the symmetry the `oneOf` rename started: `every` (input) and `allOf` (output) already mean the same thing — `allOf`'s own doc comment is literally "every listed edge fires" — they just carry different names by accident of build order (`every` was built first, before `oneOf`/`allOf` existed as output kinds to mirror). `single`↔`single`, `oneOf`↔`oneOf` (this design), and now `allOf`↔`allOf`.

**Unlike the `any`→`oneOf` change, this is a pure rename — no behavior, mechanism, or shape change at all.** `every`'s readiness check (all declared edges must have arrived), its bag payload shape, and the `every`-combo `Failed_A_B` routing built in `c9d3676` are untouched; only identifiers change:

- `types.ts`: `InputSpec`'s `{kind: "every"}` → `{kind: "allOf"}`; `InputPayload`'s matching branch.
- `define.ts`: the `every(...edges)` helper is **deleted outright, not renamed** — confirmed (not assumed) that `allOf<Es>(...edges): {kind:"allOf"; edges: Es}` already exists as the *output* helper, with the exact structural shape the renamed input kind needs. Input authors reuse the existing `allOf()` directly, the same way `single()` is already shared between input and output today — no new function needed.
- `membrane.ts`: `EveryInvoke` → `AllOfInvoke` (or similar), the `kind === "every"` branch condition only — its body is unchanged.
- `elaborate.ts`: `resolveInputSpec`'s `"every" in input` branch → `"allOf" in input`; the pre-scan (`everyCombosByKey`) and `synthesizeEveryFailedEdges`/`failedEveryEdgeName` get renamed to match (`allOfCombosByKey`, `synthesizeAllOfFailedEdges`, `failedAllOfEdgeName`) — same logic, new names.
- `runtime.ts`: the `kind === "every"` check in `Failed<In>` routing renamed to `"allOf"`.
- `schema.ts`: `nodeSchema()`'s `every` input conditional and `oneOf`-list entry rename their key to `allOf`.
- `hash.ts`: `InputSpecFingerprint`'s `{kind: "every"}` branch and `fingerprintInput`'s matching return both rename to `allOf` — missed in the first pass of this doc, worth calling out since `hash.ts` was otherwise declared "no changes needed" for the `oneOf` half of this work and it'd be easy to assume that covers `every`/`allOf` too.
- Every real `.node` YAML file using `every:` today — `examples/todo-list/src/nodes/AddTodoToList.node` — updates to `allOf:`.

## Explicitly out of scope

- Building the deferred `first`/`each` recurrence-over-time kinds (still gated on cycle/bounded-iteration support, unrelated to this rename-that-became-a-removal). Note `first` is now doubly free of collision risk — not reused here, and not what this construct means.
- A genuine "exclusive, first-of-several-wins, closes the door" primitive, if one is ever actually needed — this design deliberately does *not* preserve that behavior (see Motivation); building it for real would be new, separate work, not a variant of this one.
- Any new implementation-sharing mechanism in `hash.ts`/`implementation.ts`.
- Per-edge dependency precision in `.topology` alias expansion (uniform expansion to all shadows is the deliberate, final answer for this pass, not a placeholder).
