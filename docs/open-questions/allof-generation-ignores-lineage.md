# `allOf` generation produces bags the runtime could never deliver

Status: open.
Last grounded: 2026-10-01 — `generate.ts:208` generates each edge in an `allOf`
bag independently; confirmed against `resolveIdentity`.

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

## The hard part

Knowing *which* fields a join would have made equal. Candidates, none settled:

- **Correlate by shared field name and type**, across edges in the bag. Cheap and
  wrong in general — two edges can legitimately carry different `pin`s.
- **Correlate by common ancestry in the declarations.** The wiring says which edge
  both inputs descend from; fields traceable to that ancestor are the ones that
  must agree. Principled, and needs a notion of field provenance through a node
  that weir does not currently have — a node body is opaque, so nothing knows
  that `NormalizedParcel.pin` came from `ParcelRequest.pin`.
- **Let the declaration say so**, e.g. a `correlate: [pin]` key on the `allOf`
  input. Honest about the fact that only the author knows, and it is one more
  declaration key with the four-site write/read problem this project keeps
  hitting.
- **Generate the bag by running the graph** rather than synthesizing it — generate
  one root payload and traverse. Most faithful by construction, since it produces
  only bags the runtime can produce; costs the gate its independence from
  implementations of the upstream nodes, which may not exist yet.

The last one is interesting precisely because it inverts the current design: the
gate generates inputs *to* a node, when the invariant it needs is a property of
the path that reaches the node.

Related: [properties over collections](properties-over-collections.md) asks the
same question one shape up.
