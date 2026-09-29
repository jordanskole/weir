# A property cannot quantify over a gathered collection

Status: open.
Last grounded: 2026-09-29 — `examples/soc-triage`'s `summarizeAlert` still
declares no properties; `property.ts`'s operator set is still first-order.

## The question

Found building `gather`. The spec's own Testing list asked for *"a property
relating the output to **every** element — not one"*, precisely because a fan-in
property naming a single input is a false green that had already been fixed once.

It is not expressible. `property.ts`'s `resolvePath` walks dotted paths over
**fixed** keys (`input.IdentityContext.entityId`), and a gathered collection's
keys are runtime data — an entity id nobody knows at declaration time. There is
no honest weaker version: `get: input` resolves to the collection object, and
comparing an output field to that is meaningless.

So `summarizeAlert` ships with **no** properties, deliberately, rather than one
that passes because it checks nothing.

## What covers it instead

Stated exactly, so the gap is not overstated:

- **Examples.** Concrete keys are knowable in an example — `summarizeAlert`
  declares the two-entity case and the empty one.
- **Generated cases.** `generateInputCases` varies a gather's collection size
  with the case index, so the empty collection is reached.

What generated cases **cannot** do is reject an implementation that fails on the
empty collection: a case coming back `Failed<In>` is a legitimate outcome, since
declining an input is allowed, so throwing on empty is indistinguishable from
declining it. The declared example is the only thing pinning it.

## Not decided

Whether the property language gets a quantifier (`every`/`some` over a
collection with a bound variable — a real extension to a deliberately
first-order grammar, and the one that would most threaten decidability), a
narrower `count`-shaped operator that would at least let a gather assert
cardinality, or whether property coverage of collection-shaped inputs is simply
out of scope and examples are the answer.

The first is the honest fix and the largest. Recorded rather than picked while
building the feature that revealed it.

**Adjacent ask, from the blue-ribbon pressure test:** the same grammar cannot
order an enum, so "combined provenance is never stronger than either input" — a
lattice law — is unwritable. The reporter's suggestion was `ordinal: true` on an
enum field rather than a general escape hatch, on the grounds that a general one
breaks decidability. Worth deciding alongside the quantifier, since both are
"what may the property language grow".
