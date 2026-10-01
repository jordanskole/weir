# blue-ribbon-slice

One real slice of [blue-ribbon-properties](https://github.com/jordanskole/blue-ribbon-properties)'
ETL, modelled as a weir program. Written to find friction, not to be a good example.

**What it does.** Resolve one Michigan parcel's identity block: route the request by trust
path, fetch it, normalize away everything five counties disagree about (including owner
names), find a point inside the polygon, ask the statewide layer which township that point
is in, and join the two halves — combining their provenances.

```
routeCounty --oneOf--> directCountyFetch  [zone: county-gis] -----+
                  \                                               |
                   +-> proxiedCountyFetch [zone: third-party-proxy]+
                                                                  |
                                                          RawParcelFeature
                                                                  |
                                                          normalizeParcel
                                                            /          \
                                            ParcelCentroid             |
                                                  |                    |
                                    townshipResolution [state-gis]     |
                                                  |                    |
                                          TownshipLookup       NormalizedParcel
                                                  \                    /
                                                   +--> resolveIdentity
```

**Diagram:** [trust boundaries, from declarations alone](../../docs/diagrams/blue-ribbon-trust-boundaries.html)
— the four zones, the six network hops, and what `weir sys` says each one carries.

## It runs

```
weir check .                        # ✓ 9 edges, 7 nodes, 3 inlined from composites
weir sys .                          # zones, crossings, what carries what
weir plan ParcelRequest ParcelIdentity .   # rediscovers both routes
```

`weir run` **cannot** execute this: the CLI has no way to supply effect handlers, and three
nodes declare `effect: http`. Use the harness instead, which supplies them directly:

```
cd ../ts-prototype
npx tsx ../blue-ribbon-slice/harness.ts '{"pin":"062-026-300-020-00","county":"Iosco"}'
npx tsx ../blue-ribbon-slice/harness.ts '{"pin":"10-003-013-20","county":"Osceola"}'
```

Both give `firings 6, pulses 6, residue []`. Iosco resolves `provenance: aggregator`
(it transits app.fetchgis.com); Osceola resolves `verified`. The fixture payload for Osceola
contains `OWNER: "SPRAGUE WILLIAM E"` and no owner field appears anywhere downstream.

## Where the friction is written down

Each friction is argued in the file where it bit, not collected here:

| # | Where | What |
|---|---|---|
| ~~1~~ | `edges/RawParcelFeature.edge` | **RETRACTED.** The assertion runs; the schema was weak. And `outFields=` was already a schema I had written. Dissolves into #2. |
| **2** | `nodes/routeCounty.node` | **Now the load-bearing one.** #1 and #11 dissolve into it. Five edges is right; 83 is configuration wearing an ontology costume. |
| 3 | `edges/TownshipLookup.edge` | **CORRECTED, and worse.** The two-terminal `oneOf` version is expressible and runs correctly — and leaves residue, so a correct run exits non-zero. |
| 4 | `topology/main.topology` | **Run granularity.** The real job is 17,839 parcels → one parquet. Per-parcel makes the export homeless; per-corridor needs a gather that tolerates holes. |
| 5 | `edges/RawParcelFeature.edge` | **Types die at convergence.** The `oneOf` is erased the moment both branches produce one edge. |
| 6 | `edges/Provenanced.edge` | **No generics**, so no `Field<T>`. Field spread covers most of it. |
| 9 | `edges/ParcelCentroid.edge` | **Cardinality is invisible.** 1 centroid or 3,265 look identical to a field label. |
| 10 | `nodes/fetchParcelPage.node.flagged` | **Chatty effects.** Pagination cannot be gathered. Deliberately non-parsing. |
| ~~11~~ | `nodes/normalizeParcel.node` | **Mostly dissolved.** Field names become declarations under five real schemas. Only the area arithmetic stays in a body. |
| 13 | `topology/directCountyFetch.topology` | **Zone is on the topology**, so a single-node wrapper exists only to carry a label. |
| 8 | *see `../blue-ribbon-soil/src/edges/Vertex.edge`* | **RETRACTED.** A polygon IS declarable — `seq` as index promotes position to a key. Same mistake as #1. |
| 14 | `edges/NormalizedParcel.edge` | **No extensible envelope.** Found by implementing, not modelling: provenance had to be threaded through a node with no use for it. |

`nodes/resolveIdentity.node` records a lineage question I could not answer from the docs —
a fan-in where one input is the *ancestor* of the other — and the run that answered it.
It works; nothing in the spec says so.

## Corrections

Three claims in this slice were falsified on re-examination and are corrected
**in place, with the wrong version preserved** — see the CORRECTED blocks in
`RawParcelFeature.edge`, `TownshipLookup.edge` and `resolveIdentity.node`.
Frictions 1, 8 and 11 shrank or retracted; 2 grew to absorb them; 3 got worse.

The transformation-heavy companion slice is [`../blue-ribbon-soil`](../blue-ribbon-soil).

## Known weir bugs this surfaced

- `weir test` runs effect nodes' declared `examples` as ordinary functions, which always
  throws. 6 of 12 test cases here fail for this reason alone. `verify` handles effects as a
  third category; `test` should too.
- Effect nodes inlined from a composite are tested twice, under both names.
- `weir sys` reports `Provenanced` as `orphaned` — but it is a field-spread source, which is
  legitimately never produced or consumed by a node.
