# soc-triage

**What this example is for: data-driven fan-out.** One alert produces N entities, each entity gets
its own pair of independent investigations, and each pair rejoins with *its own* entity — not with
another's.

It has a second job, which is why it is worth reading even though its declarations are unremarkable:
**it was written before the feature that makes it work.** An outside reader sketched a SOC triage
app from weir's own documentation, checked out the repo, and wrote these `.edge`/`.node`/`.topology`
files. They are committed here unchanged.

## The topology

```
extractEntities (Alert -> many Entity, origin)
        |
        |  one Entity instance per element
        v
     Entity ---+-- investigateIdentity (-> IdentityContext) --+
               |                                               v
               |                              assembleEvidence (allOf [IdentityContext,
               |                                               |        AssetContext] -> EntityEvidence)
               +-- investigateAsset    (-> AssetContext) ------+
                                                               v
                                                           assess (EntityEvidence -> Assessment)
```

```yaml
extractEntities:
  then:
    investigateIdentity:
      then:
        assembleEvidence:
          then:
            assess: {}
    investigateAsset:
      then:
        assembleEvidence: {}
```

Nine firings for two entities: `extractEntities` once, then two investigations, one join and one
assessment **per entity**.

## What it used to do

Before spread, this exact program elaborated cleanly, ran, and reported `stopped: "quiescence"` with
`failures: []`. Three of its five nodes fired. `investigateIdentity` and `investigateAsset` each
fired **once**, holding the whole `Entity` collection, and returned `Failed<In>`:

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

## Why the declarations did not change

`investigateIdentity` declares `input: Entity`. That is what its author meant and it is now correct,
because a `many Entity` output logs one real instance per element under the plain edge name — and
piece (1)'s existing rule takes it from there: *a single-input node fires once per unconsumed
instance reaching it along a declared arc*. Two `Entity` instances arrive on the arc, so it fires
twice. No `each:`, no new input kind, no runtime branch.

The collection is still logged, under the reserved name `Many_Entity`. Nothing reads it yet; keeping
it is what leaves a future vectorized consumer — one node taking the whole batch, paying retention
per batch rather than per row — reachable.

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

## What it still cannot express

A second alert in the same run. `extractEntities` is an origin, and origins fire once — one alert is
one external event, so one run. Several alerts are several runs, and nothing joins across
correlations by design.
