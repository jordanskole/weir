# There is no fan-out primitive: a `many` output is one token, not N

Status: resolved (2026-09-26).
Last grounded: 2026-09-29.

## The question

An outside reader with the repo checked out proposed the shape the readme's
"iterates per item" claim implies — *one alert → `many` entities → N
investigation diamonds → reassembly* — and it did not run, with nothing saying
so. `logOutput` handled `single` and `many` identically, one `append` under the
declared edge name, so a downstream node fired **once** holding the whole
collection.

"Per item" meant per *lineage group*, and the only ways to get N groups were a
cycle or N hand-written origin nodes. Neither is data-driven. The gap only
became visible after `allOf` joins by lineage shipped: the join arrived before
anything that produced the groups it joins.

## What resolved it

[Spread materializes elements](../superpowers/specs/2026-09-26-spread-materializes-elements.md).
A `many` output logs the collection token **and** one real instance per entry,
each citing the collection. Downstream needs no new declaration — a
`single`-input node already fires once per unconsumed instance on a declared arc.

Two things worth keeping, because the entry's own analysis nearly missed both:

- **Materializing is the feature, not an implementation choice.** Firing a
  downstream node N times against the one collection token would give every
  element's descendants the same nearest common ancestor, so a later fan-in
  would pair *across* elements — reintroducing the exact mispairing the lineage
  join exists to prevent, through the mechanism meant to enable per-element work.
  Elements cite the **collection**, not what the producing invocation consumed.
- **Keeping the collection was argued as leaving a vectorized consumer
  reachable** — a consumer that still does not exist. It turned out load-bearing
  for something else: `gather` reads it as the barrier's count. Evidence for that
  one judgement call, not a general argument for keeping things around.

The ergonomic question it raised (batch by default, or explosion by default)
settled as: `many` in *output* position spreads, because that is the fan-out its
name implies. A vectorized `input: many X` is a separate, still-unbuilt kind.

## What it left behind

- [a collection is keyed, and streamed data is ordered](keyed-versus-ordered-collections.md) —
  which this entry predicted would have to be settled *first*, and did not:
  spread inherited `many`'s existing keyed commitment unchanged.
