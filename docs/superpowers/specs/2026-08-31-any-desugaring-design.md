# `any` becomes authoring sugar, not a runtime primitive

Status: approved design, not yet implemented.
Supersedes: parts of `6d2558c` ("Build any as InputSpec's coproduct-shaped sibling to every"), which built `any` as a real runtime `InputSpec` kind.

## Motivation

`any(A, B)` was built as a fourth `InputSpec` kind alongside `single`/`every`: a readiness check satisfied by the first of several distinct declared edges to arrive, with `Fn` receiving a `{edge, payload}` tag so it knows which one fired.

Working through a concrete use case (`any(Bird, Turtle, Dog) -> Animal`, a widening/declassifying node) surfaced that this doesn't need to be a runtime primitive at all:

- A plain single-input node already "just runs on input" — there's no extra waiting semantics `any` adds beyond what `single` already has, once you notice `any(A, B)` is really two independent readiness checks, not one joint one.
- Decomposed into `WidenBird: single(Bird) -> Animal`, `WidenTurtle: single(Turtle) -> Animal`, `WidenDog: single(Dog) -> Animal`, each node is fully typed with no runtime discriminant — closer to weir's "no ambient dispatch" ethos than a single `Fn` that internally branches on a string tag.
- It resolves the `any`-input `Failed<In>` routing gap (deferred in `c9d3676`) for free: after desugaring, every former `any`-node is an ordinary single-input node, and its `Failed<In>` already routes through the mechanism built for the single-input case.
- It surfaced a real, previously-unnoticed bug: `hash.ts`'s `fingerprintInput` has no `any` case and silently mis-fingerprints an `any`-input node as `every`. This disappears along with the primitive rather than needing its own fix.

The ergonomic win of writing one `any(...)` block instead of hand-authoring N node files is preserved as authoring-time sugar — it just doesn't survive into the runtime `InputSpec` union.

## What's removed

- `types.ts`: the `{kind: "any"; edges: AnyEdgeDef[]}` member of `InputSpec`, and its `InputPayload` conditional branch.
- `membrane.ts`: `AnyInvoke`, the `any`-branch of `membrane()`, the `MembraneInvoke` discriminant's `any` case.
- `runtime.ts`: `AnyMultiInvoke` collapses back to whatever single non-`single` case remains (just `every`'s call shape) if nothing else needs the generic alias; the `any`-input branch of the `Failed<In>` routing `if`/`else if`/`else` (currently the `else` — unrouted, pushed to `failures`) goes away entirely, since no node ever reaches the runtime with `kind: "any"` after desugaring.
- `elaborate.ts`: the `{any: [...]}` recognition branch inside `resolveInputSpec` (replaced — see below, not simply deleted).
- `define.ts`: the `any(...edges)` helper (replaced by a different-shaped helper — see below).
- `hash.ts`: no change needed — the latent any-mis-fingerprints-as-every bug is moot once no node ever carries `kind: "any"`.

**Not removed, on reflection: `schema.ts`.** `nodeSchema()`'s `any` conditional validates the *authoring-level* `.node` YAML shape — the `input: {any: [...]}` syntax stays valid to write, only what `elaborate()` resolves it to internally changes. Its existing `given` shape (`taggedOne`, exactly one tag per example) is still correct post-desugaring too: an author still writes one example per triggering edge, tagged by name; `elaborate()` is what changes, routing each tagged example into the matching shadow's own `examples` list instead of into one node's shared list. So `schema.ts` needs zero changes — a fact worth stating plainly since it's easy to assume everything `any`-shaped goes away together.

## What's added

### `elaborate.ts`: desugaring at `.node`-parse time

A `.node` file whose `input` is `{any: [...]}` no longer produces one `NodeDecl` with `kind: "any"`. Instead, parsing it produces **N separate `NodeDecl`s**, one per listed edge:

```
HandleFailed.node:
  input: {any: [Failed_Todo, Failed_Person]}
  output: Recovered
```

expands to two entries in `elaborate()`'s `nodes` record:

- `HandleFailed__Failed_Todo`: `{name: "HandleFailed__Failed_Todo", input: {kind: "single", edge: Failed_Todo}, output: <same>, examples: <see below>}`
- `HandleFailed__Failed_Person`: `{name: "HandleFailed__Failed_Person", input: {kind: "single", edge: Failed_Person}, output: <same>, examples: <see below>}`

The original name (`HandleFailed`) is **not** a real key in `nodes` after desugaring — it only survives as an alias (below).

**Naming convention:** `<OriginalName>__<EdgeName>`, double underscore. Chosen over a single underscore because edge names can already contain underscores (`Failed_Todo_TodoList` already exists as a real synthesized edge), so a single-underscore join would be ambiguous to a human reading a node name, even though nothing actually needs to parse it back apart programmatically.

**Examples:** a `.node` file's `examples` block, under the current `{any: [...]}` YAML shape, tags each example by which edge it's demonstrating (mirroring how `oneOf`'s `expect` is tagged today) — `given: {Failed_Todo: {...}}` for one example, `given: {Failed_Person: {...}}` for another. Splitting examples across the desugared shadows means each shadow only gets the examples tagged for its own edge. Confirmed (not assumed): `parseNodeFile`'s own `NodeDecl` construction treats `examples` as optional (`examples?: unknown`, included only if present) — it does not itself enforce non-empty, that enforcement lives one layer up, in `schema.ts`'s JSON-schema validation of the *original, pre-desugared* `.node` YAML shape. So a shadow ending up with zero matching examples after the split is not a new failure mode this design introduces; it inherits the same already-existing, already-accepted gap any hand-authored single-input node with an empty `examples` list already has today (nothing currently cross-checks that every declared `any`/`every` edge is demonstrated at least once). No new handling needed.

### `.topology`: a name-alias map keeps the original name writable

`runtime.ts`'s worklist only ever attempts a node when something pushes it onto the queue via `wiring.feeds` (or it's a declared origin) — it is not a periodic fixed-point scan of every node. So for a desugared shadow to ever fire, `.topology` has to reference it, directly or through an alias, or it silently never gets attempted even once its input is logged.

`elaborate()` carries forward a `Map<string, string[]>` (original name → its shadow names) produced by the desugaring step. `parseTopologyFile`'s `resolveNodeName` (and whatever builds the final `Wiring.feeds`/`Wiring.origins`) consults this map: a `.topology` reference to `HandleFailed` — whether as a `then:` parent or a child — expands to references to **all** of `HandleFailed`'s shadows, uniformly.

This is deliberately imprecise rather than smart: a `.topology` entry like

```
SomeNodeThatConsumesTodo:
  then:
    HandleFailed: {}
```

expands `feeds["SomeNodeThatConsumesTodo"]` to include both `HandleFailed__Failed_Todo` and `HandleFailed__Failed_Person`, even though `SomeNodeThatConsumesTodo` firing can only ever actually produce `Failed_Todo`, never `Failed_Person`. The redundant shadow gets pushed onto the worklist and attempted, finds its own declared edge absent from the log, and `tryFire` returns `false` — a wasted check, not a correctness problem (idempotent via the existing `fired` set, no side effects from a failed readiness check). No per-edge dependency analysis needed to avoid this; it's not worth building given the worklist model already makes a wasted attempt free of consequence.

### `define.ts`: a different-shaped TS-level helper

The removed `any(...edges)` returned an `InputSpec` fragment, the same shape `single`/`every`/`oneOf`/`allOf` all return. Since desugaring produces *N* `NodeDef`s rather than one `InputSpec`, its replacement is not a drop-in — it needs to return something like `Record<string, NodeDef>` (or accept a name and return that record keyed by the same `<Name>__<EdgeName>` convention `elaborate.ts` uses, for consistency between the YAML path and direct TS-level construction used in tests).

**Left open for the implementation plan:** the exact signature. A plausible shape:

```ts
function defineAnyNodes<Es extends AnyEdgeDef[]>(
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

- Removed: `membrane.test.ts`'s `describe("membrane — any", ...)` block (8 tests), the `any`-specific input-resolution test in `elaborate.test.ts` (it asserted `{kind: "any", edges: [...]}` — replaced, not just deleted, by the desugaring tests below), `runtime.test.ts`'s `any`-specific tests (fires-on-first, still-collects-in-failures).
- Unchanged: `schema.test.ts`'s `any`-shape accept/reject tests — still valid, since `schema.ts` itself doesn't change (see above).
- Added: `elaborate.test.ts` coverage for the desugaring itself (one `.node` file → N `NodeDecl`s, correct naming, correct per-edge example splitting) and for `.topology`'s alias expansion (a reference to the original name resolves to all shadows, both as parent and child). `runtime.test.ts` coverage proving a desugared shadow actually fires end-to-end through the worklist via an aliased `.topology` reference, and that `Failed<In>` for a desugared shadow routes through the existing single-input mechanism with no new code.
- `docs/design-history.md` gets a new entry documenting the reversal — what `any` was as a runtime primitive, why it came out, what replaced it — rather than silently rewriting history. `docs/open-questions.md`'s "Is `any` actually the right name..." entry gets resolved/removed (the question dissolves along with the primitive it was about naming).

## Explicitly out of scope

- Any change to `every`'s routing or shape (untouched by this work).
- Building the deferred `first`/`each` recurrence-over-time kinds (still gated on cycle/bounded-iteration support, unrelated to this rename-that-became-a-removal).
- Any new implementation-sharing mechanism in `hash.ts`/`implementation.ts`.
- Per-edge dependency precision in `.topology` alias expansion (uniform expansion to all shadows is the deliberate, final answer for this pass, not a placeholder).
