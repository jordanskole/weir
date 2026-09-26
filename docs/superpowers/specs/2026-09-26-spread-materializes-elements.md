# Spread: a `many` output materializes its elements

Status: draft.

## Motivation

Weir has no data-driven fan-out. A `many X` output is one token carrying a keyed collection (`runtime.ts`'s `logOutput`: *"a `many` result is already one collection payload, never N separate instances"*), and nothing turns it into N tokens. The consequences are concrete:

- `examples/soc-triage` — one alert, N entities, an independent investigation per entity rejoining per entity — cannot be built at all. Written out in full it fails at elaboration on one arc.
- `examples/manuscript-review` gets its three revisions from a **cycle**, one at a time, because that is the only way to obtain N instances of a shared ancestor. One draft fanning out into N reviews in parallel is inexpressible.
- The coordinate model's **x** axis (design-history.md, "Three axes and a clock") — "which sibling of a fan-out", the collection key — has never meant anything at runtime. It exists only in the netlist.

This is the **per-item-lineage** feature, not the streaming one (design-history.md, "Fan-out and pipes are duals"). A pipe needs nothing new; piece (1) already built it. What needs building is the case where each element genuinely takes its own treatment and rejoins.

## The decision that shapes everything: spread materializes

Spread must append **real instances**, not fire a node N times against one collection token.

The virtual alternative fails on lineage, which is the whole point of the feature. If N firings all cite the collection instance, every descendant of every element shares that collection as its nearest common ancestor. A downstream fan-in would then group all N entities' evidence into one pile and pair across entities — precisely the mispairing `joinRows` exists to prevent, reintroduced by the feature meant to make per-item work possible.

Materialized, each element is a token with its own id, citing the collection. Two elements' descendants have *different* nearest common ancestors — their own element instances — so the join separates them for free, using machinery that already exists. **x becomes real**: an element's collection key is carried by its own payload's declared `index` field, so the coordinate is recoverable from the log without a new envelope field.

## Design

### 1. The collection stays a token; elements are logged beside it

`logOutput`'s `many` branch appends the collection **and** one instance per element:

- the collection under a reserved edge name, `Many_<Edge>` (`Many_Entity`), the way the run root uses a reserved `Run` name — not a synthesized `.edge`, because the type system has no way to express "an edge whose payload is a bare keyed collection" (see `fuzz.ts`'s `assertManyOutput`, which exists for exactly that reason)
- each element under the **plain** edge name (`Entity`), with `causationIds: [<collection instance id>]`

Keeping the collection is what preserves the vectorized path: a node that wants the whole batch has something to read, and its retention cost stays per-batch rather than per-row. Nothing consumes it yet — `input: many X` is §5, deferred — and that is deliberate rather than an oversight.

### 2. No new InputSpec kind is needed for the scalar path

This is the spec's main finding, and it makes the change much smaller than the `each:` syntax sketched in conversation.

Once elements are ordinary instances under the plain edge name, **piece (1)'s existing rule already fires a node once per element**: *a single-input node fires once per unconsumed instance reaching it along a declared arc*. `investigateIdentity` declares `input: Entity`, the wiring gives it an arc from `extractEntities`, and two `Entity` instances arrive on that arc. It fires twice. No `each:`, no new declaration, no runtime branch.

So `examples/soc-triage` becomes buildable **with its declarations exactly as already written**. That is the strongest evidence the shape is right: the author wrote what they meant, and the only thing wrong was that the runtime could not produce the tokens.

### 3. `assertWiringTypes` Rule A loses its `many` branch

Built 2026-09-25, and correct for the world as it was: a `many X` output could not satisfy a `single X` input because no input was ever `many` and nothing spread a collection. Its error message says so in those words.

Spread makes that arc satisfiable, so the branch must go: a `many X` output now satisfies a `single X` input (via elements) and will satisfy a `many X` input (via the collection) when §5 lands. Rule A's name-mismatch branch is untouched, and Rule B is untouched.

Stated plainly rather than quietly reversed: a check shipped one day and removed the next is the correct outcome when the thing it prohibited becomes possible. What would be wrong is leaving it in place and making the feature unreachable.

### 4. Lineage, worked through

For `extractEntities: Alert → many Entity` producing two entities:

```
Run#1                                        causationIds []
Alert#1        <- origin output              causationIds [Run#1]
Many_Entity#1  <- the collection             causationIds [Alert#1]
Entity#1       <- element "e-principal"      causationIds [Many_Entity#1]
Entity#2       <- element "e-asset"          causationIds [Many_Entity#1]
```

`IdentityContext#1` and `AssetContext#1` both descend from `Entity#1`; their intersection's highest-`seq` member is `Entity#1`, so `assembleEvidence` groups there and not at the collection. `Entity#1` and `Entity#2` are **peers** — same producing node, same firing — which matters for the hold rule: two elements' arms stalled in opposite directions are held apart by the peer clause, the same way two revisions already are in `manuscript-review`.

One consequence worth stating: the elements share a firing (`envelope.id`), so the correction made for the run root — *peers must differ by firing* — must not exclude them. That fix compares `firingOf(peer) === firingOf(nearer)` on the **ancestor** being tested, and elements are ancestors of different candidates rather than candidates themselves, so it does not apply. To be verified by execution, not by this paragraph.

### 5. Explicitly out of scope

- **`input: many X`**, the vectorized path. The collection is logged and waiting; nothing reads it yet. Its own spec, and the place to settle whether a `∀ p . …` property on a vectorized node quantifies over rows or batches.
- **Ordered collections.** `many` is keyed by the referenced edge's `index`, order non-load-bearing (open-questions.md, "A collection is keyed, and streamed data is ordered"). `Many_LogEvent` remains unbuildable for the same reason it is today.
- **Retention policy.** A `many` output now costs N+1 instances. Whether retention should be per-mode is recorded in design-history.md ("Fan-out and pipes are duals") and not decided here.
- **`noop`**, still designed and unbuilt, still waiting on composite nodes.

## Testing

Break-proofs required: break the implementation, confirm the test reddens. `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked — review them as unchecked code.

1. A `many` output logs the collection under `Many_<Edge>` **and** one instance per element under `<Edge>`, with each element citing the collection.
2. A downstream `single`-input node fires **once per element**, with no `each:` declaration anywhere.
3. Two elements' descendants join at their **own** element, not at the collection — assert the pairing, not just the count. A lineage-blind join produces the right *number* of rows here and the wrong halves, which is the failure mode that made `manuscript-review`'s first test vacuous.
4. `examples/soc-triage`, restored unchanged from its original declarations, elaborates and runs to completion with every node firing.
5. An element's payload satisfies its edge's schema — the collection entry was already validated by `assertManyOutput`, but the element is now a real instance and must assert like one.
6. `assertWiringTypes` no longer rejects `many X → single X`, and still rejects an arc whose producer emits nothing the consumer declares.
