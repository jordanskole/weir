# blue-ribbon-soil

The **transformation-heavy** half of blue-ribbon-properties, modelled to test a
claim I made about the [boundary-heavy half](../blue-ribbon-slice):

> "A weir program for the whole pipeline would be a thin typed shell around
> several large untyped nodes, and the shell would be describing the least
> interesting part."

**That prediction was wrong.** What came out is the opposite shape.

## What it models

Criterion A2 — *dry ground adjacent to wet amenity*, which
`01_VACANT_LAND_CRITERIA.md` calls "the whole search". Parcel boundary in,
dry/wet acreage and a dwelling suitability rating out.

```
ParcelGeometry -> buildSoilQuery -> [zone: usda-sda] fetchClippedSoilPolygons
                                           |  SPREAD: N soil segments
                                  parseSoilPolygon      (WKT -> structure)
                                  measureSoilPolygon    (the area formula)
                                           |  GATHER
                                     totalByMukey
                                      /          \
                          buildComponentQuery     |
                          fetchComponents [effect]|
                                | SPREAD -> GATHER|
                          collectComponents       |
                                      \          /
                                    summarizeSoil        (FAN-IN 1)
                                      /          \
                          buildRatingQuery        |
                          fetchDwellingRating     |
                                      \          /
                                  assembleAdjacency      (FAN-IN 2)
```

**Three chained effects** where each request is computed from the previous
answers. **Two spreads and two gathers**, the second nested downstream of the
first. **Two fan-ins**, both ancestor-diamonds.

## It runs

```bash
cd ../ts-prototype
npx tsx bin/weir.ts run ../blue-ribbon-soil \
  --impl /tmp/soil-impl --payload /tmp/soil-bodies/payload.json \
  --effects /tmp/soil-bodies/effects.ts --run soil-1
```

`✓ quiescence — 14 firings, 12 pulses`, and `weir test` is **9 passed, 0
failed**. Acreages match an independent Python computation to six decimals.

## The three findings

**1. The typed shell reached *into* the interesting part, not around it.**
In blue-ribbon the area formula is a SQL string constant
(`duckdb/compute.ts:12`) interpolated into a DuckDB query. Its own comment
records that two previous formulations were "proven wrong by ~8.4x at this
latitude during spec verification." **The single most error-prone number on the
card has no unit test, because you cannot unit-test a SQL fragment without
standing up a database and loading geometry into it.** Its nondeterminism
budget is zero — it is shoelace area times two constants times a cosine. Here
it is `measureSoilPolygon`, a pure node with properties, including the one that
catches the actual bug class (`abs()` on a signed area; SDA does not guarantee
ring winding).

**2. The spatial engine is load-bearing in fewer places than the architecture
implies.** Modelling forced the question "what actually needs DuckDB here?" The
answer in this path is *nothing*: the **clip** happens server-side at USDA
(`mupolygongeo.STIntersection`, `ssurgo.ts:44`), and the **area** is
arithmetic. `ST_Buffer` for corridor selection is genuinely spatial — but that
is universe selection, upstream, once per corridor, not per parcel.

**3. Serialization erases classification, and you cannot have both.** This is
the sharp new friction. `weir sys` reports the USDA crossing as
`carries linkable` — **not** `location` — because `SoilQuery` hands over the
geometry as a WKT *string*. The `classification: location` labels on
`Vertex.lng/lat` are real, but they live on an edge that never crosses. Either:

- serialize in a **pure node** → testable, but the crossing edge is an opaque
  string and the labels are lost exactly where they matter; or
- serialize in the **effect handler** → the crossing carries `location`, but
  the serializer becomes untested host code outside the acceptance gate.

weir measures a zone crossing at the node boundary; the wire format is produced
inside the handler. Those are not the same place.

## #8, retracted

See [`src/edges/Vertex.edge`](src/edges/Vertex.edge). I claimed a polygon was
undeclarable because a ring is positional. That proves the *element* needs a
positional key — not that the *collection* is opaque. `index: seq` promotes
position to a key, nested `many` elaborates, and every coordinate becomes
range-validated and labellable. Same mistake as #1, and I would not have found
it without being told to try.

## Friction #14, recurring independently

`DryWetAdjacency` **cannot carry the PIN**. Getting it there means adding a
`pin` field to five edges about *soil* that have no use for a *parcel*
identifier. blue-ribbon has no such problem: `deriveCard(input)` takes the
parcel and the soil results as two arguments of one function. Hitting this
again, in a different subgraph with different metadata, is what makes it
structural rather than a modelling mistake.
