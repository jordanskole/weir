# The declared envelope

Status: draft.

## Motivation

Cross-cutting metadata has to be a declared field on every intermediate edge on
its path. The pressure test hit this twice, in subgraphs with nothing in common,
which is what moves it from one project's modelling habit to structural:

- A trust value distinguishing a direct county fetch from one through a
  commercial proxy is decided two nodes upstream and needed two nodes
  downstream. The intermediate node, which has no use for it whatsoever, had to
  declare four fields to carry it.
- A parcel's PIN is eleven nodes upstream of where it is needed. Getting it there
  means adding a `pin` field to five edges that are about *soil*.

This is the direct cost of "no ambient state". The incumbent codebase pays
neither, because `deriveCard(parcel, soilResults)` takes both as arguments to one
function — which is precisely what weir gives up, on purpose, and mostly to good
effect.

**weir already has an envelope.** `correlationId`, `causationIds`, `timestamp`,
`step`, `identity`, `node`, `contractHash`, `schemaHash`. It is simply not
extensible, so every one of those was a decision only the framework could make.

## 1. It is `Identity`'s propagation rule that differs, not its reading rule

`Identity` is already author-adjacent metadata delivered through the envelope
rather than over a wire, and `scope` already governs who may read it:

```ts
// membrane.ts, narrowIdentity
throw new Error(`scope "${declaration}": only "read:Identity:<field>" resolves to anything today.`);
```

That `today` is the hook. What this spec adds is **not a new reading mechanism**
— it is the same one, pointed at more than one thing.

What genuinely differs is propagation. **`identity` is run-global**: supplied
once at the trigger, passed unchanged into every invocation's context, identical
for every token in the run. The metadata this question is about is **per-token**
and flows along lineage — two parcels in one run have different PINs, and two
fetches in one run have different trust.

So:

| | `Identity` | a declared envelope |
|---|---|---|
| declared by | the framework | the author |
| supplied at | the trigger | the trigger, or a node |
| varies within a run | no | **yes, per token** |
| read via | `scope` | `scope` |

## 2. An envelope is an edge whose instances ride with tokens

A `.envelope` file is parsed by the **edge** parser. It gets field types,
validations, `enumValues`, nested edges and `classification` for free, and
nothing new has to be invented for any of it:

```yaml
# Provenance.envelope
label: Provenance
description: How much the value on this token can be trusted, and where it came from.
fields:
  trust:
    type: utf8
    label: Trust
    description: Weakest of the sources that contributed to this token
    nullable: false
    enumValues: [verified, inferred, aggregator, listing]
    ordinal: true
    combine: meet
  pin:
    type: utf8
    label: PIN
    description: The parcel this token is about
    nullable: false
    classification: linkable
    combine: same
```

Reusing the edge parser is the point rather than a convenience: a classification
on an envelope field is then the *same* classification `weir sys` already
queries, so metadata that crosses a zone boundary is visible to the leakage
query without a second mechanism.

## 3. Two new field keys, and only two

**`combine:`** — what happens when a fan-in merges several inputs' envelopes.
Per field, because the answer genuinely differs per field:

- **`meet`** — the weakest wins. A combined trust is no stronger than its
  weakest source, which is the lattice the pressure test's `combineProvenance`
  already implements by hand.
- **`join`** — the strongest wins. Integrity is a join where confidentiality is
  a meet, which is why one walk cannot produce both.
- **`same`** — all inputs must agree, or the firing fails as `Failed<In>`. The
  right rule for an identifier: two tokens about *different* parcels joining is
  a bug, and this is what catches it.

**`ordinal: true`** — this enum's declared order is a total order, so `meet` and
`join` mean something. Also the exact thing
[properties over collections](../open-questions/properties-over-collections.md)
records as unwritable today: *"the property language cannot order an enum"*. One
key, two problems.

No default for `combine`. A field with none is a declaration error rather than a
guess, because every wrong guess here is silent: `meet` where `same` was meant
merges two parcels without complaint.

## 4. Where values come from: the trigger, or a node's declared contribution

**The trigger** supplies the initial envelope alongside the payload. A run about
one parcel starts with `pin` set once, and it reaches all eleven nodes.

**A node contributes statically**, with a new `contributes:` key:

```yaml
# fetchProxied.node
effect: http
input: ProxiedCountyQuery
output: RawParcelFeature
contributes:
  trust: aggregator
```

That covers the case that motivated this: trust is decided by *which node ran*,
not by what it computed. `fetchDirect` contributes `verified`, `fetchProxied`
contributes `aggregator`, and every token either produces carries it onward with
no intermediate edge mentioning it.

`contributes` is **fingerprinted**. It changes what downstream sees, so it is
behaviour, and the same argument that put `scope` in the hash applies unchanged.

**Deliberately not in this spec: a contribution computed from the payload.** It
would mean a node's `Fn` returning `(payload, envelope-delta)` rather than a
payload, which changes every implementation's signature for a case nothing has
yet needed. Static contribution covers both motivating examples. Recorded as the
obvious next thing, not built.

## 5. Adding an envelope field must not move every contract hash

The tension this spec has to survive: an envelope is program-wide, so a naive
design makes every node's contract depend on it, and adding a field invalidates
every accepted implementation in the program. That would be worse than the
problem.

**`scope` resolves it, and this is the main reason to reuse it.** A node's
contract includes what it *reads*:

```yaml
# resolveIdentity.node
scope:
  - read:Provenance:trust
```

A node that does not name a field does not see it, and its hash does not move
when that field is added. Only nodes that actually read the new field are
re-accepted — which is correct, because only they changed.

Propagation is unaffected by scope: a token carries its whole envelope whether or
not the node it passes through can read it. **Carrying is not reading**, and
conflating them is what would force every intermediate edge to declare a field
again — the very problem this exists to remove.

## 6. What propagation means, exactly

- **`single`** — the output token inherits the input token's envelope.
- **`allOf`** — per field, by that field's `combine` rule. A field absent from
  some inputs is absent from the result; `same` over one present value is that
  value.
- **`many` (spread)** — every element inherits the collection's envelope. An
  element is *about* the same thing the collection was.
- **`gather`** — per field, by `combine`, across the members. This is where
  `meet` earns itself: a summary over 3,265 parcels is as trustworthy as its
  worst parcel, which is the answer a reader wants and nobody computes by hand.
- **An origin** inherits from the trigger.

A node's `contributes` is merged **after** propagation, so a node can override
what reached it. That ordering is what makes `fetchProxied` work: it consumes a
query carrying `verified` from the trigger and emits a feature carrying
`aggregator`.

## 7. Explicitly out of scope

- **Dynamic contribution** (§4) — an envelope delta computed from the payload.
- **Enforcement.** A classification on an envelope field is queryable by `weir
  sys` like any other; nothing here rejects a crossing, and the
  [enforcement question](../open-questions/integrity-inbound.md) is unchanged.
- **`read:` on anything but `Identity` and declared envelopes.** Whether `scope`
  generalizes to *every* edge stays open.
- **Envelope fields in the log's own storage format.** They ride on
  `InstanceEnvelope`, which is already written; no format decision is forced.
- **Making `Identity` one of these.** It plainly is one — run-global, read by
  `scope` — and folding it in afterwards is a refactor this spec does not need
  to take to prove the design.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A `.envelope` elaborates through the edge parser: field types, validations and
   `enumValues` are enforced on it exactly as on an edge.
2. A value supplied at the trigger reaches a node several hops downstream that
   declares `read:` for it, with **no** intermediate edge naming it — the PIN
   case, and the whole point.
3. A node that does **not** declare `read:` receives nothing, and its contract
   hash is unchanged by the field existing. The property §5 rests on.
4. A node's `contributes` overrides what reached it, and downstream sees the new
   value — the trust case.
5. `contributes` is fingerprinted: two otherwise identical nodes contributing
   different values have different contract hashes.
6. `combine: meet` at a fan-in takes the weakest, using the declared enum order.
7. `combine: same` fails the firing as `Failed<In>` when two inputs disagree, and
   passes when they agree. The identifier case, and the one that catches a
   cross-item join.
8. `combine: join` takes the strongest — the integrity direction, tested so the
   lattice is not assumed to be one-directional.
9. A gather combines across **members**, so a summary is as weak as its worst
   element.
10. A spread's elements each inherit the collection's envelope.
11. A field declaring no `combine` is a declaration error, not a default.
12. `ordinal: true` is required for `meet`/`join`, and its absence is an error
    naming the field.
13. An envelope field carrying a `classification` shows up in `weir sys`'s
    crossings, like any other labelled field.
14. Every existing example still elaborates and runs, and no contract hash moves
    — nothing in the corpus declares an envelope.
