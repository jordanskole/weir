# No extensible envelope, so cross-cutting metadata is an edit to every edge

Status: open. Recurred independently in two unrelated subgraphs.
Last grounded: 2026-09-29.

## The question

Found by writing an implementation, not by drawing a graph. A trust value that
distinguishes a direct county fetch from one through a commercial proxy is
decided two nodes upstream and needed two nodes downstream — and the intermediate
node, which has no use for it whatsoever, had to declare four fields to carry it.

This is the direct cost of "no ambient state". The sibling project does not pay
it, because its `Field<T>` attaches provenance at the moment a value is created
and it rides inside the payload.

weir already **has** an envelope — `correlationId`, `causationIds`, `step` — it
is simply not extensible.

## Why it is structural rather than one project's modelling habit

**It recurred in a second, unrelated subgraph with different metadata.** A soil
slice's `DryWetAdjacency` cannot carry the parcel's PIN: the identifier is eleven
nodes upstream, nothing in between has any use for it, and getting it there means
adding a `pin` field to five edges that are about *soil*.

Provenance the first time, an identifier the second. The incumbent codebase pays
neither cost, because `deriveCard(parcel, soilResults)` takes both as arguments
to one function — which is precisely what "no ambient state" gives up.

## What it would also solve

**A computed classification.** The two lattices — a *static* confidentiality
label on a field, a *computed* trust value meet-ed over the sources that actually
answered — are the same algebra with different lifetimes, and weir supports only
one lifetime. A declared envelope propagating along lineage is the natural home
for the second.

## A precedent to set deliberately

`undeclared?: string[]` from [the drift spec](../superpowers/specs/2026-09-29-drift-and-fork.md)
§3 would be the **first extensible field on the envelope**. Whether that
generalizes into an author-declared envelope is this question, and it is better
decided than discovered.
