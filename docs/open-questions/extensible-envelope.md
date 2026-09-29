# No extensible envelope, so cross-cutting metadata is an edit to every edge

Status: specced, not built — `2026-09-29-the-declared-envelope.md`, status draft.
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

## A precedent that was set, then decided

`undeclared?: string[]` from [the drift spec](../superpowers/specs/2026-09-29-drift-and-fork.md)
§3 shipped on 2026-09-29 and **is** the first extensible field on the envelope —
so the precedent this entry warned about being set by accident was set that
morning. Deciding the general shape the same day was cheap; after three more
ad-hoc fields it would have been a migration. That timing is the whole argument
for having picked this next.

[The declared envelope](../superpowers/specs/2026-09-29-the-declared-envelope.md)
is the answer, and the shape it took was not the one this entry assumed. It is
**not a new mechanism**: `scope` already governs who may read envelope-delivered
metadata (`read:Identity:<field>`, whose error message says *"resolves to
anything today"*), and reusing it is what keeps adding an envelope field from
moving every contract hash in the program — only nodes that name the new field
are re-accepted.

What genuinely differs from `Identity` is propagation, not reading: `identity` is
run-global, supplied once at the trigger and identical for every token, while
this is per-token and flows along lineage. That distinction is the spec's §1 and
was not obvious from this entry.
