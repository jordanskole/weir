# `allOf` generation produces bags the runtime could never deliver

Status: resolved (2026-10-01 — the correlation is derived from the declared
properties, no new declaration key).
Last grounded: 2026-10-01.

## The observation

`generateInputCases` builds an `allOf` case like this:

```ts
const bag: Record<string, unknown> = {};
for (const edge of input.edges) {
  bag[edge.name] = generatePayload(edge, rng, i);
}
```

Each edge is generated in isolation. For `resolveIdentity`, which takes
`allOf: [NormalizedParcel, TownshipLookup]`, the two `pin` fields come out as
unrelated random strings.

`resolveIdentity` declares the property *"both inputs describe the same parcel"*,
asserting `output.pin` equals the `pin` of **each** input. Against an uncorrelated
bag that is unsatisfiable: the candidate can project one PIN and fail the
property, or decline and be reported `vacuous`. No implementation can pass.

## Why this is a correctness gap, not just a weak generator

The runtime does not deliver uncorrelated bags, and cannot. An `allOf` node's
inputs are joined by **nearest common ancestor** — the two instances in a bag
always share lineage, so values inherited from that shared ancestor agree. A
`NormalizedParcel` and a `TownshipLookup` that reached the same join descend from
the same `ParcelRequest`, which is where the PIN came from.

So the generator manufactures inputs that violate an invariant the runtime
enforces, and then holds the implementation responsible for handling them. The
property is *true of every bag the runtime can produce* and false of most bags the
generator produces.

This is the mirror of the `gather … until` finding: a rule that is correct for one
shape, applied to a shape it was not derived from.

## RESOLVED: the declaration already said it, in the property

The four candidate mechanisms below were all weighed and none was built, because a
fifth was available that none of them is: **read it out of the properties.**

`verdict`'s property, in full:

```yaml
and:
  - eq: [get output.revision_id, get input.StyleReport.revision_id]
  - eq: [get output.revision_id, get input.FactReport.revision_id]
```

Transitively that requires `input.StyleReport.revision_id ==
input.FactReport.revision_id`. `resolveIdentity`'s property has the identical shape
on `pin`. Neither compares its two inputs *directly* — both go through the output —
so the derivation has to be transitive, which is why `correlatedInputFields`
(property.ts) unions the operand paths into equivalence classes rather than pairing
them. Classes containing `input.<Edge>.<field>` members from more than one edge are
the correlated groups, and `generateInputCases` unifies them after building the bag.

Nothing new is declared. The two real instances were both already stating the
constraint; it only had to be read.

### The load-bearing subtlety

Only an `eq` the property **unconditionally requires** implies a correlation, so the
walk descends through `and` and stops everywhere else. An `eq` under `not` is
required to be *false*; under `or` it may be either; as an `implies` antecedent it is
a guard rather than a requirement. Correlating on those would make the generator
unify fields a property deliberately lets differ — and the break-proof for it is in
`property.test.ts`: recursing into every operand reddens the three cases that assert
it does not.

An operand that is not a bare `get` is also not an alias: `output.age == input.A.age
+ 1` says nothing about `input.B.age`.

### What it fixed

| node | before | after |
|---|---|---|
| `resolveIdentity` (blue-ribbon-slice) | `vacuous` | **accepted** |
| `verdict` (manuscript-review) | `vacuous` | **accepted** |

On `verdict`, 0 of 50 generated bags had matching `revision_id`s before and 50 of 50
after.

### Why not the four below

- *Shared field name and type* — wrong in general, and the test for it is in
  `fuzz.test.ts`: a node with no property gets no correlation, because two edges may
  legitimately carry different values under one name.
- *Common ancestry in the declarations* — still the most principled answer, and
  still needs a notion of field provenance through an opaque node body that weir
  does not have.
- *A `correlate:` key* — one more declaration key with the four-site write/read
  problem this repo keeps hitting, to say something already said.
- *Generate by running the graph* — the most faithful, and it costs the gate its
  independence from implementations that may not exist yet.

### What stays open

The derivation only sees what a property states. A node whose inputs must agree but
which declares no property saying so still gets uncorrelated bags — correctly, since
nothing declared says otherwise, but it means **the fix is only as good as the
properties**. A node with a correctness guard and no property is still
unimplementable-as-gated, and nothing warns about that.

Related: [properties over collections](properties-over-collections.md) asks the
same question one shape up.
