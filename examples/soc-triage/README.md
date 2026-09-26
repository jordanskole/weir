# soc-triage

**What this example is for: data-driven fan-out and its dual.** One alert produces N entities, each
entity gets its own pair of independent investigations, each pair rejoins with *its own* entity — not
with another's — and then every entity's assessment is gathered back into one conclusion about the
alert. Spread and gather, which together are one `traverse`.

It has a second job, which is why it is worth reading even though its declarations are unremarkable:
**it was written before the features that make it work.** An outside reader sketched a SOC triage app
from weir's own documentation, checked out the repo, and wrote these files. The original five nodes'
declarations are committed as they wrote them — which is the point, since the fix for the first gap
they found was to make the runtime do what those declarations already said.

What has been added since, and why each addition is a change to the *example* rather than to their
declarations: the `.topology` moved the per-entity fan-out into a composite once composites existed
(the flattened wiring is identical either way); `Assessment` gained `index: entityId`, which a gather
requires of the edge it collects; and `summarizeAlert` plus `AlertAssessment` are new, closing the
second gap the same reader found by reading the committed example — the scatter without its gather.

## The topology

```
extractEntities (Alert -> many Entity, origin)
        |
        |  one Entity instance per element
        v
   +----------------- investigate (composite) ------------------+
   |  Entity --+-- investigateIdentity (-> IdentityContext) --+  |
   |           |                                              |  |
   |           +-- investigateAsset    (-> AssetContext) -----+  |
   +-------------------------- exit: allOf ---------------------+
                                |
                                v
                     assembleEvidence (allOf [IdentityContext,
                                |             AssetContext] -> EntityEvidence)
                                v
                            assess (EntityEvidence -> Assessment)
                                |
                                |  N Assessment instances, one per entity
                                v
                     summarizeAlert (gather Assessment -> AlertAssessment)
```

```yaml
# investigate.topology — a composite: the per-entity investigation
input: Entity
output:
  allOf:
    - IdentityContext
    - AssetContext
terminals:
  - investigateIdentity
  - investigateAsset
wiring:
  investigateIdentity: {}
  investigateAsset: {}

# main.topology — a chain. No node is named twice.
extractEntities:
  then:
    investigate:
      then:
        assembleEvidence:
          then:
            assess:
              then:
                summarizeAlert: {}
```

**The fan-out lives inside the composite; the root is a chain.** That is the point of a composite: a
`.topology` file is geometrically a tree and cannot express reconvergence, so the join moves to a
boundary. `investigate` fans out internally — two top-level keys, still a tree — and its *exit*
contract is `allOf[IdentityContext, AssetContext]`. The root then consumes that as one step.

Written flat, `assembleEvidence` would have to be named twice, once under each investigation, the way
`examples/recipe` names `bake` twice. Composites are inlined at elaboration, so the flattened wiring
is identical either way; what changes is that no authored file has to mention a node twice.

It is also the decomposition you would draw on a whiteboard: "investigate an entity" is a unit with a
contract, reusable and independently runnable, rather than two nodes that happen to sit next to each
other.

Ten firings for two entities: `extractEntities` once, then two investigations, one join and one
assessment **per entity**, then one gather over both — `1 + 4 + 4 + 1`.

## Why the gather fires once, and once only

`summarizeAlert` declares `input: { gather: Assessment }` and knows nothing about being fed by a
spread. What makes it fire at the right moment is that **the collection token records the count**:
`Many_Entity` holds two entries, every `Assessment` reaches it by ordinary lineage
(`Assessment ← EntityEvidence ← IdentityContext ← Entity ← Many_Entity`), and the barrier is
complete when two `Assessment` instances descend from it. No new notion of doneness, no scoped
quiescence — a count and a walk that already existed.

Which spread it gathers from is **not declared, and must not be.** It is the nearest collection
ancestor the candidates share. Declaring it would make a node's contract depend on the topology above
it, which is exactly the property this example exists to demonstrate weir does *not* have:
`investigateIdentity` says `Entity → IdentityContext` and knows nothing about being one of N.

Two consequences worth knowing before reading the declarations:

- **`Assessment` gained `index: entityId`.** A gather's payload is a keyed collection, so the gathered
  edge needs a real key — the same requirement `output: many` already carried.
- **An alert naming nothing recognizable still produces an `AlertAssessment`.** Zero entities spread
  to an empty collection, which gathers immediately to an empty collection rather than waiting for the
  first of zero things. `summarizeAlert` declares that as its second example, because it is the case
  most likely to be got wrong.

## What it used to do

Before spread, this exact program elaborated cleanly, ran, and reported `stopped: "quiescence"` with
`failures: []`. Three of the five nodes it had then fired — `summarizeAlert` did not exist yet.
`investigateIdentity` and `investigateAsset` each fired **once**, holding the whole `Entity`
collection, and returned `Failed<In>`:

```
Entity: id should be string, got undefined; kind should be string,
        got undefined; value should be string, got undefined.
```

A collection of entities, validated against the schema for one entity. The message blames the
`Entity` contract, two nodes downstream of the actual mistake, and `assembleEvidence` and `assess`
never ran at all with nothing recording that they hadn't.

That failure produced three separate pieces of work: an elaboration-time wiring check so an arc that
can carry nothing is rejected rather than discovered at runtime, the **run root** so ancestry is
total, and **spread** so a `many` output becomes N tokens.

## Why the node declarations did not change

`investigateIdentity` declares `input: Entity`. That is what its author meant and it is now correct,
because a `many Entity` output logs one real instance per element under the plain edge name — and
piece (1)'s existing rule takes it from there: *a single-input node fires once per unconsumed
instance reaching it along a declared arc*. Two `Entity` instances arrive on the arc, so it fires
twice. No `each:`, no new input kind, no runtime branch.

The collection is still logged, under the reserved name `Many_Entity`. It was kept to leave a future
vectorized consumer — one node taking the whole batch, paying retention per batch rather than per row
— reachable, and that consumer still does not exist. **`gather` is what actually reads it**, for a
purpose nobody had in mind when the decision was made: it is the barrier's count. A speculative
justification turned out to be load-bearing for a different feature.

## Why the join does not cross entities

Each element is a real token with its own id, so `IdentityContext` and `AssetContext` for one entity
both descend from *that entity's* instance. The nearest common ancestor of the correct pair is the
entity; of a crossed pair, the collection — which is further away. Grouping picks the nearest, so
the correct pairing wins, and the hold rule covers the case where the correct partner has not arrived
yet.

Had spread fired the investigations N times against the one collection token instead of
materializing elements, every investigation's output would have descended from the collection and
the join would have had no way to tell the two entities apart. That is the reason spread appends
rather than iterates.

## What the domain nouns are and are not

Worth saying plainly, because the names invite more credit than the example
has earned. This is a lineage test wearing SOC vocabulary. There is no IdP,
EDR, SIEM, threat-intel lookup, temporal context, confidence score or model
reasoning; "evidence" is an entity id and a string, and the assessment
concatenates two of them.

More pointedly, **both investigations run on every entity**. Nothing routes on
`kind`, so a principal gets an asset investigation and an asset gets an
identity one. The examples quietly demonstrate only the sensible half of
that — identity is shown with a principal, asset with an asset — while the
topology runs both branches for both. What the example is actually proving
is *N things × 2 independent branches → N correctly paired joins*, and the
domain names are how that stays readable.

That is a fair thing for a fixture to be. It stops being fair the moment the
README implies otherwise, which is why this section exists. Making the
investigations real — routing on `kind`, acquiring evidence through
`effect:` nodes that can fail — is the obvious next pressure test and is not
done here.

*(Both this limitation and the property bug above were found by the outside
reader who wrote the original sketch, reading the committed example.)*

## What it still cannot express

**A second alert in the same run.** `extractEntities` is an origin, and origins fire once — one alert
is one external event, so one run. Several alerts are several runs, and nothing joins across
correlations by design.

**A summary that knows which alert it is about.** Read `AlertAssessment`'s fields and the gap is
visible: entity ids and a count, no alert id. `summarizeAlert` sees every `Assessment` and cannot see
the `Alert` those assessments came from, because a gather takes N of *one* edge and nothing else. The
shape it wants is `allOf: [gather: Assessment, Alert]`, which no input kind expresses. Worked around
elsewhere by having the spread copy whatever the gather needs into every element — duplication in the
payload standing in for a missing combinator (docs/open-questions.md, "A gather composes with
nothing").

**A property over the gathered collection.** `assembleEvidence` carries a property asserting its
output names the entity *both* its inputs were about — the fix for a real false green. The analogous
claim about `summarizeAlert` ("the summary names every assessment it gathered") **cannot be written**:
weir's property language resolves dotted paths over fixed keys, and a gathered collection's keys are
runtime data. So `summarizeAlert` declares no properties at all rather than one that passes because it
checks nothing. Its examples — including the empty-collection one — are what cover it
(docs/open-questions.md).
