# Is `many` a compositional type, or only a one-way fan-out?

Status: resolved (2026-09-27, `gather`). One half deliberately still unbuilt.
Last grounded: 2026-09-29.

## The question

Spread does *one alert → N entities → work per entity → rejoin each entity's
branches*. The dual — *N assessments → one alert assessment* — had no
expression. Two things were missing: `input: many X` did not exist, and even
with it there was no `Many_Assessment` token to read, since nothing regathered
the descendants of spread elements into a new collection.

It also asked something `allOf` does not. An `allOf` node's cardinality is
**statically known**; a gather's is **determined at runtime** by the earlier
`many`, so readiness had to be "has every descendant of that collection
finished" — a barrier the pulse loop had no notion of. Quiescence is global;
this appeared to need it scoped to a lineage.

## What resolved it

[`gather`](../superpowers/specs/2026-09-27-gather.md). `input: { gather: X }`
collects every instance of one edge descended from a single spread and fires
once with the collection, keyed by each entry's own `index`.

**The barrier this entry called intractable was not: the collection token
records the count.** Completeness is "N instances descend from this collection,
where N is its entry count" — a count and a walk that already existed. No
lineage-scoped quiescence.

That the collection was reachable at all is a consequence of a decision taken
for an unrelated and speculative reason (keeping a vectorized consumer
reachable). Recorded as evidence for that specific judgement call.

Three things the build settled that the question had not framed: **failure is
all-or-nothing**, because `sequence`'s signature says so — a group with any
`Failed_*` descendant fails as a whole under a synthesized `Failed_Many_X`
rather than hanging until the budget; **the empty collection fires immediately**,
which falls out of the count rather than needing a case; and a gather with no
spread above it is rejected at elaboration rather than silently never firing.

## What stays open

`input: many X`, the **vectorized consumer**, is still unbuilt and is genuinely
a separate thing: it consumes a collection someone already produced, where
gather *builds* one. Sequencing them the other way round would not have helped.

It is also the shape [keyed-versus-ordered collections](keyed-versus-ordered-collections.md)
would need for bulk row data, so those two want deciding together.
