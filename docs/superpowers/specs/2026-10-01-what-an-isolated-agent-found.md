# What an isolated agent found

Status: implemented (the `routeCounty` declaration fix; the five findings are open
questions, not built). Four of the blue-ribbon slice's pure nodes were drafted by
an agent that had never heard of weir.

## The experiment, and why it was run this way

The blue-ribbon slice has had declarations since 2026-09-28 and no
implementations. The four `fn`s sitting in a scratch directory were written
incidentally, to make the harness run at all; nobody was ever *asked* to write
them, and none had been through `weir accept`.

weir's claim about the acceptance gate is specific: **an isolated agent receives
the sealed contract and nothing else, and drafts against it.** So the honest test
is an agent under exactly that condition — not the agent that wrote the
declarations, which knows that Osceola's source PINs use spaces and the canonical
form uses dashes, and would have reproduced that from memory rather than from the
contract. A pass by that agent proves its memory works. A pass by a stranger
proves the contract carries what it claims to.

One agent, four contracts (`weir contract <node>`), the `weir accept` command, and
an explicit prohibition on reading anything else in the repository — no
declarations, no weir source, no docs, no sibling project.

**Result: 0 of 4 accepted.** All four reproduced every declared example exactly.
All four failed at the generated-input stage. The interesting part is that only
one of the four failures was the implementer's fault, and that one was also
accepted once a declaration bug was fixed.

## 1. The gate rewards fabrication and rejects refusal

This is the finding that matters most, because the gate is the thing that is
supposed to catch exactly this.

Two implementations of `parcelCentroid`, differing by one line:

```ts
  } catch (e) { lng = 0; lat = 0; }                      // ✓ accepted
  } catch (e) { throw new Error("unparseable boundaryJson"); }  // ✗ vacuous
```

Both reproduce the declared example. The first is accepted. The second is
rejected with:

```
✗ parcelCentroid was not accepted
  vacuous   no generated case produced a real output, so every property passed on nothing
```

The accepted implementation writes `{lng: 0, lat: 0}` — a point in the Gulf of
Guinea — into the durable log for every parcel whose boundary fails to parse. The
rejected one declines to invent a location. **The gate prefers the one that
makes something up.**

`vacuous` is not wrong about what it observed: nothing was exercised, so nothing
was proved. The defect is that there is no way to pass honestly. `boundaryJson`
is declared `utf8`, so `generateInputCases` emits character noise, and the only
correct response to character noise is to decline — which is a failing verdict.
An implementation is therefore selected for its willingness to fabricate.

Recorded as [the gate rewards fabrication](../../open-questions/the-gate-rewards-fabrication.md).

## 2. The property that would have caught it checks something else

`parcelCentroid` declares exactly one property:

```yaml
- name: the centroid lies within the boundary's bounding box
  description: >-
    Weaker than point-in-polygon but checkable without a geometry library,
    and it catches the failure that actually happens: a shoelace
    implementation that divides by 6*area with the wrong sign, putting the
    centroid outside the parcel entirely.
  expr:
    eq:
      - get: output.pin
      - get: input.pin
```

The name describes bounding-box containment. The `expr` compares PINs. It never
reads `lng`, `lat`, or `boundaryJson`. This is the recurring false-green pattern
— a check whose prose claims more than it performs — and it is why §1's
fabricating implementation
passes: the only property that could have caught it doesn't look at the output.

**The author was not lying.** The property language has `lit get eq ne lt lte gt
gte add sub and or not implies` and nothing else: no JSON parsing, no array
indexing, no min/max over a collection. Bounding-box containment over a geometry
that arrives as an opaque JSON string is *inexpressible*. The author wrote the
strongest check available and gave it the name of the one they wanted.

So friction #1 causes the false green. The opaque string defeats the generator
(§1) **and** defeats the property language, and the two compound: the field that
cannot be generated is the field that cannot be constrained.

Two things follow, and they are separable:

- `weir check` cannot tell a weak property from a strong one, but it *can* tell
  that **no property mentions `lng` or `lat` at all**. Property coverage over
  declared output fields is mechanically checkable and would have flagged this
  node. See [property coverage](../../open-questions/property-coverage-over-output-fields.md).
- A property's `name` is free prose that the gate prints as though it were the
  check. Nothing reconciles them.

## 3. A declaration bug reported as an implementation failure

`routeCounty` failed with:

```
property "the PIN is never altered by routing" did not hold for {"pin":"LC1QlHrN","county":"Osceola"}
```

The implementation was correct. `routeCounty` is a `oneOf` node, so its result is
tagged — and `property.ts:58` documents the path shape for exactly this case:
*"`output.edge` and `output.payload.x` for a tagged `oneOf` result"*. The
declaration wrote `get: output.pin`, which cannot resolve for **any** candidate.

Changing that one path to `output.payload.pin` turns the verdict into
`✓ accepted routeCounty` against the same unmodified source. Fixed in this commit.

The misattribution is deliberate, and the reasoning is sound in general.
`fuzz.ts` reclassifies an output-rooted `PropertyPathError` into an ordinary
property failure because, as `property.ts` puts it, *"`output` is the candidate's
data, not the contract's"*. True when a candidate omitted a field it should have
returned. False here, where the path contradicts the node's own declared output
kind and is unresolvable by construction.

weir has what it needs to separate the two statically: it knows the output kind is
`oneOf`, so it knows the only valid top-level segments are `edge` and `payload`.
This is the same shape as `gather … until`'s Rule C finding — a static rule that
holds for one output kind and silently misfires on another.

## 4. The generator produces inputs the runtime cannot

`resolveIdentity` takes `allOf: [NormalizedParcel, TownshipLookup]` and declares
*"both inputs describe the same parcel"*. It is unsatisfiable as generated.
`generate.ts:208`:

```ts
const bag: Record<string, unknown> = {};
for (const edge of input.edges) {
  bag[edge.name] = generatePayload(edge, rng, i);
}
```

Each edge is generated independently, so the two `pin` fields are unrelated
random strings. The implementation's only options are to project one PIN and fail
the property, or decline and be `vacuous`.

This is not merely a weak generator — it contradicts an invariant the runtime
enforces. An `allOf` node at runtime never sees two unrelated instances: joins
form by nearest common ancestor, so the instances in a bag always share lineage,
and fields derived from that shared ancestor agree. The generator ignores the
invariant, manufactures bags the runtime could never deliver, and then holds the
implementation responsible for them.

Recorded as [allOf generation ignores lineage](../../open-questions/allof-generation-ignores-lineage.md).

## 5. The gate accepted four invented production URLs

Once §3's path was fixed, `routeCounty` was accepted — carrying endpoint URLs for
five counties, of which **four of the seven distinct URLs appear nowhere in the
contract**:

```
IN CONTRACT: https://services8.arcgis.com/…/OsceolaCountyParcels_view/…
IN CONTRACT: https://services3.arcgis.com/iosco/FeatureServer/0/query
IN CONTRACT: https://app.fetchgis.com/?currentMap=iosco
FABRICATED : https://services8.arcgis.com/…/ManisteeCountyParcels_view/…
FABRICATED : https://services8.arcgis.com/…/RoscommonCountyParcels_view/…
FABRICATED : https://services3.arcgis.com/otsego/FeatureServer/0/query
FABRICATED : https://app.fetchgis.com/?currentMap=otsego
```

The contract gives two counties by worked example and says nothing about the
other three. The agent extended the pattern by analogy, said so in its report,
and noted that nothing in the gate could detect it. It is right: no schema
constrains which host is the correct host, and no property can.

**This is mechanical evidence for
[configuration versus ontology](../../open-questions/configuration-versus-ontology.md).**
An endpoint table is configuration. It has no business being inside a node body,
and the fact that an isolated agent put it there — and that the gate blessed it —
is the argument for that question's position rather than a new problem. The
acceptance gate verifies shape and invariants; configuration is neither, so
configuration smuggled into an implementation is accepted silently and
indistinguishably from the real thing.

## 6. What the contract spends itself on

Measured across the four contracts, by bytes of `description` prose:

| node | prose | share addressed to weir rather than to an implementer |
|---|---|---|
| `routeCounty` | 5,974B | 77% |
| `normalizeParcel` | 16,504B | 89% |
| `parcelCentroid` | 6,780B | 53% |
| `resolveIdentity` | 16,339B | 53% |

`normalizeParcel`'s input description opens `CORRECTED 2026-09-29. THE ARGUMENT
BELOW IS WRONG. READ THIS FIRST`, argues about `runtime.ts`, cites spec paths, and
deliberately preserves a superseded argument. That record is valuable and belongs
in the repository. It is also 89% of what a stranger reads in order to implement
the node.

[Sealed contract length](../../open-questions/sealed-contract-length.md) already
tracks this as a *length* cost and correctly refuses truncation. The measurement
says the problem is **audience**, not length, which is evidence for that
question's `description`-versus-`brief` option specifically and against its cap
option. A declaration field acquires a second reader the moment the declaration
becomes a payload, and nothing marks which reader a given field was written for.

Separately and cheaply: `contract.ts:127` builds `failure: { input:
contractInputSpec(node.input) }`, recomputing the structure already at `input:`
six lines above. Byte-identical in all four contracts — 11%, 28%, 30% and 27% of
each payload, carrying no information. `hashNode` fingerprints the `NodeDef`
rather than the `SealedContract`, so dropping the duplication moves no contract
hash. Left as a decision rather than a change, because `SealedContract` is a
public shape and self-containment per field is a defensible reason to keep it.

## What this says about the sealed-contract loop

The loop's premise held in the one place it was cleanly testable: given a
contract with two worked examples and a well-formed property, a stranger wrote a
correct `routeCounty` on the first attempt, and the only thing standing between
it and acceptance was a typo in the declaration.

Everywhere else, the gate's verdict was about the declaration or the generator
rather than the implementation:

| node | verdict | whose fault |
|---|---|---|
| `routeCounty` | property violation → `✓` after fix | the declaration's path |
| `normalizeParcel` | `vacuous` | opaque `utf8` geometry defeats the generator |
| `parcelCentroid` | `vacuous` | same — and the honest impl is the rejected one |
| `resolveIdentity` | `vacuous` | the generator violates the runtime's join invariant |

Three of four `vacuous` verdicts trace to one root cause: **a field the generator
cannot produce makes every property on that node vacuous, and the node
unimplementable-as-gated.** That is friction #1 — the opaque type — arriving as a
mechanical result rather than an argument. The pressure test's author raised it,
then talked themselves out of it on the grounds that the assertion still runs.
The assertion does still run. The *generator* does not, and the gate depends on
the generator.

## The unprompted finding

The agent was told to record curiosity rather than satisfy it, and recorded
wanting to read the generator to learn whether opaque string fields can be
seeded. It also reported discovering by probing — not by reading — that
`get: "output.pin"` resolves against the top level of a tagged result, and that
non-enumerable own properties pass both the deep-equal example check and the
schema assertion.

The second of those is worth confirming independently. The first says the
property language's path-resolution rules are documented in `property.ts`'s
header comment, where an implementer drafting against a sealed contract will
never look, because the sealed contract is all they are given. The contract ships
`properties` without shipping the grammar they are written in.
