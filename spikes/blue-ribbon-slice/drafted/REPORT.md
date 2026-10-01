# Sealed-contract implementation report

Four nodes implemented from contracts alone, in
`/private/tmp/claude-501/-Users-jordan-code-weir/b65b3030-acb1-4e63-980a-914e4527a9cd/scratchpad/brp-impl-fresh/`.

**Result: 0 of 4 accepted.** All four reproduce every declared example exactly
(the gate reports example mismatches explicitly and reported none). All four
fail on the generated-input stage, and in three cases I believe no honest
implementation can pass.

---

## 1. routeCounty — FAIL

```
✗ routeCounty was not accepted

  property  "the PIN is never altered by routing" did not hold for {"pin":"LC1QlHrN","county":"Osceola"}
  property  "the PIN is never altered by routing" did not hold for {"pin":"2Dp3UtmFRMaD0dLbqdlXHbk1EYuCcdJLpOntU2Gm","county":"Manistee"}
  property  "the PIN is never altered by routing" did not hold for {"pin":"sePQR6f7B7igawEM4","county":"Roscommon"}
  property  "the PIN is never altered by routing" did not hold for {"pin":"T6rSlGZh J","county":"Iosco"}
  property  "the PIN is never altered by routing" did not hold for {"pin":"BKvLuTsC1R 4BIsgRtX5fDZi9lSSoAkPvnN3uX","county":"Otsego"}
```

Both examples pass. The property fails on every input, including the ones where
the PIN is copied through byte-for-byte.

### What the contract gave me
- The branch split: three counties direct, two proxied. Unambiguous, stated
  twice, and the two output enums partition the five input enum values, so the
  routing table is fully determined by the schemas alone.
- Osceola's and Iosco's endpoint URLs, from the examples.
- `proxyHost` is a one-value enum, so it is not a guess.

### What I had to guess
- **Three of five endpoint URLs.** Manistee, Roscommon and Otsego endpoints
  appear nowhere in the contract. I fabricated them by analogy with the two
  given (same ArcGIS org id for the direct ones, same `services3.arcgis.com/<county>`
  shape for Otsego). They are almost certainly wrong, and nothing in the gate
  can tell: `endpoint` is only constrained to be a 10..500-character string.
  This is the single largest unforced hole in the four contracts — the node's
  entire job is to produce an endpoint, and 60% of its output values are
  undetermined.
- **Otsego's `referer`.** One data point (`?currentMap=iosco`) extrapolated to
  `?currentMap=otsego`.

### Could any implementation pass?
**No.** The contract is internally contradictory, and I verified both halves:

- The examples' `expect` is `{"edge": ..., "payload": {...}}` and the gate
  deep-equals it strictly. I probed by adding a top-level `pin`; the example
  check failed with `actual {"edge":...,"pin":...,"payload":{...}}`.
- The property reads `{"get": "output.pin"}` off the **top level** of the
  returned value, not out of `payload`. I probed this too: with a top-level
  `pin` present, the property failures for the direct counties disappeared.

So the examples forbid exactly the key the property requires. To be
implementable the contract needs **one character changed**: the property must
read `{"get": "output.payload.pin"}` (or the examples must show the flat
`{edge, ...fields}` shape the property assumes). Everything else about the node
is well specified.

One honesty note: a top-level `pin` declared with
`Object.defineProperty(out, "pin", {enumerable: false})` **does** satisfy both
checks — I confirmed the gate's deep-equal and its schema check both ignore
non-enumerable own properties while `get` sees them. That is gaming the gate,
not implementing the contract, so I did not ship it. It is worth knowing that
the escape hatch exists.

---

## 2. normalizeParcel — FAIL (vacuous)

```
✗ normalizeParcel was not accepted

  vacuous   no generated case produced a real output, so every property passed on nothing
```

Both examples pass, including the Web-Mercator-adjacent acreage arithmetic.

### What the contract gave me
- The acreage conversion, from the two examples and nothing else:
  `163567.8 / 3.755 = 43560` and `370701 / 8.51 ≈ 43560`, i.e. both counties'
  area fields are in **square feet** and the divisor is 43560, rounded to 3
  decimals. Note this directly contradicts the prose, which says Roscommon
  divides `Shape__Area` by 4046.8564224 (square metres). The examples win; I
  used 43560 for every county, and for Roscommon that is a guess I expect to be
  wrong.
- Per-county field-name dialects (`PIN` / `TaxID` / `parcelid` / `BSA_PIN`,
  `Shape__Area` / `Shape_Area` / `ACRES`) — these are in prose, not schema, but
  they are concrete enough to code against.
- `provenance` is `sourceTrust` passed straight through; both examples agree.
- PIN canonicalisation: spaces become dashes, dashes stay.
- `boundaryJson` is `JSON.stringify(feature.geometry)`; key order comes out
  right because it matches the input's.

### What I had to guess
- **`vintageAsOf` is a hardcoded `"2026-08-30"`.** No input field determines
  it, and a pure function cannot read a clock. Both examples say the same date,
  so a constant is the only thing that fits. This is a date literal baked into
  a function body, which is obviously not what was meant.
- **`vintageSourceType` is a hardcoded `"continuous"`**, for the same reason.
- **`vintageNote` templates**, reverse-engineered from the two examples:
  `"<County> county FeatureServer, direct"` for verified,
  `"<County> county FeatureServer via app.fetchgis.com proxy"` for aggregator.
  The literal `app.fetchgis.com` in the aggregator branch is a guess that it is
  always that proxy (it is the only one named anywhere).
- **Township derivation.** One example: `"MIDDLE BRANCH TOWNSHIP"` →
  `"Middle Branch"`. I strip a trailing `TOWNSHIP`/`TWP`/`CHARTER TOWNSHIP` and
  title-case. Whether a *city* MCD keeps its suffix is undetermined; I strip
  nothing but township words.
- **Rounding.** 3 decimals, because 3.755 needs 3 and 8.51 is consistent with 3.

### Could any implementation pass?
**Not honestly.** The vacuity is caused by one thing: `featureJson` is typed
`utf8` with `minLength: 2, maxLength: 2000000`, so the generator fills it with
random character noise. Random noise is not a parseable ArcGIS feature, so the
only correct response is to decline, and declining on every case is the
`vacuous` verdict. The contract's own corrected note says the honest modelling
is five real schemas; this is that friction cashing out as an unreachable node
body.

For it to be implementable the generator has to be able to produce a *feature*.
That means either the feature is structurally declared (nested fields, or a
`schema:` on the string), or the contract declares seed/generator values for
`featureJson` — e.g. the gate drawing opaque string fields from the examples'
values rather than from the character generator.

---

## 3. parcelCentroid — FAIL (vacuous)

```
✗ parcelCentroid was not accepted

  vacuous   no generated case produced a real output, so every property passed on nothing
```

The single example passes: the unit square `[[0,0],[0,2],[2,2],[2,0],[0,0]]`
gives exactly `lng: 1, lat: 1`.

### What the contract gave me
Essentially everything about the mathematics. Shoelace, exterior ring,
area-weighted, output is three fields with hard numeric ranges. This is the one
node whose *logic* the contract fully determines, and the contract says so
("exactly the shape weir is good at") — correctly.

### What I had to guess
- Which ring of a `MultiPolygon` to use (first polygon's exterior).
- What to do with a degenerate ring (zero signed area). I fall back to the
  vertex mean, which still satisfies the stated bounding-box property. The
  contract does not mention the case.
- Whether to round. I do not.
- Winding order: I rely on sign cancelling, so both orders work.

### Could any implementation pass?
**Not honestly — and I proved the gate prefers a dishonest one.** Same root
cause as normalizeParcel: `boundaryJson` is `utf8`, so the generator produces
noise and the honest response is to decline.

I probed with a version that returns `{lng: 0, lat: 0}` whenever `boundaryJson`
does not parse as geometry. The gate printed:

```
✓ accepted parcelCentroid
```

So a function that **fabricates a coordinate for every real input the generator
produces** is accepted, while the function that correctly refuses is rejected as
vacuous. I deleted that probe and shipped the honest one. This is the most
important single finding in this exercise: as the contract stands, the gate's
incentive gradient points at fabrication.

Fix is the same as normalizeParcel's: geometry must be structurally declared
(a `coordinates` field of nested f64 pairs, or a ring type), not a string.

---

## 4. resolveIdentity — FAIL (vacuous)

```
✗ resolveIdentity was not accepted

  vacuous   no generated case produced a real output, so every property passed on nothing
```

The single example passes.

### What the contract gave me
- The input is keyed by edge name: `{NormalizedParcel: {...}, TownshipLookup: {...}}`.
  Only the example's `given` tells you this; the `allOf` schema does not.
- Field projection: `county`/`acres`/`boundaryJson` from the parcel, `township`
  from the lookup.
- **`provenance` is a genuine lattice meet** and it is fully determined:
  the rank order is stated (`verified > inferred > aggregator > listing claim`),
  the example exercises `aggregator ⊓ verified = aggregator`, and the property
  names the invariant. This is the one derived value in all four contracts that
  I did not have to guess at all.

### What I had to guess
- **`vintageSourceType` combination.** Unstated. The example combines
  `continuous` (parcel) with `periodic` (township) into `continuous`. That is
  consistent with "most volatile wins" and equally consistent with "take the
  parcel's". I chose most-volatile (ordered `continuous > periodic >
  manual-confirmation > static`) because it mirrors the provenance meet. A
  coin flip with one data point.
- **`vintageAsOf` combination.** Unstated, and both sides of the only example
  carry `2026-08-30`, so the example distinguishes nothing. I take the
  lexicographically earlier ISO date, reasoning that a join is only true as of
  its oldest part. Pure guess.
- **`vintageNote` composition.** Read off one example as
  `"parcel: <a>; township: <b>"`. The null handling (one side null, both null)
  and the 500-character overflow behaviour are entirely mine — I include only
  the present parts, return `null` if both are absent, and truncate at 500.
  With generated inputs both notes can be 500 characters each, so overflow is
  not hypothetical, and the contract says nothing about it.

### Could any implementation pass?
**No.** The property `"both inputs describe the same parcel"` requires
`output.pin == input.NormalizedParcel.pin && output.pin == input.TownshipLookup.pin`.
I probed the generator by dropping my cross-input check, and it produces the two
edges **independently**:

```
property "both inputs describe the same parcel" did not hold for
  {"NormalizedParcel":{... "pin":"p3UtmFRM", "county":"aD0d", ...},
   "TownshipLookup":{... "pin":"uCcdJLpO", "township":"nt"}}
```

Two unrelated PINs. So every generated case leaves exactly two options:
project one PIN and fail the property, or decline and be vacuous. There is no
third behaviour. The node is unimplementable-to-green by construction.

Two ways the contract could fix it, and the second is better:
1. The gate must generate lineage-correlated `allOf` inputs — the whole point of
   a fan-in is that the two sides share a key, and generating them independently
   tests a situation the runtime cannot produce.
2. State the property as an implication, which the contract's own corrected note
   says is available: `implies(eq(input.NormalizedParcel.pin, input.TownshipLookup.pin),
   and(eq(output.pin, input.NormalizedParcel.pin), eq(output.pin, input.TownshipLookup.pin)))`.
   That is what the invariant actually means, and it is satisfiable.

---

## The single most valuable addition

**Declare the geometry structurally instead of as a JSON string in a `utf8`
field.** One change — replacing `featureJson` and `boundaryJson` with declared
nested structure — makes two of the four nodes (`normalizeParcel`,
`parcelCentroid`) go from unreachable-by-generation to actually testable, and it
is the only change that would have *caught a wrong implementation* rather than
merely allowed a right one. Today the generator cannot build a parcel, so the
property stage sees nothing, and the version that invents coordinates out of
noise is the one the gate rewards. The contract's own author already identified
this as friction #1 and then argued themselves out of it; the gate's `vacuous`
verdict is the mechanical proof they were right the first time.

Runner-up, and nearly free: the two property-expression bugs (`output.pin` vs
`output.payload.pin` in routeCounty, and the un-guarded cross-input equality in
resolveIdentity). Each is a one-line edit, and together they are the difference
between 0/4 and 2/4.

## One curiosity I did not satisfy

Per the ground rules, writing it down instead of looking: I wanted to read the
gate's generator to find out whether opaque string fields can be seeded, and
whether `allOf` generation has any notion of lineage. Both questions are
answerable from the outside — I answered them by probing — but the fact that I
had to probe to learn that `get: "output.pin"` reads the top level of a
`{edge, payload}` return, and that non-enumerable properties slip past both the
deep-equal and the schema check, suggests the property language's resolution
rules and the oneOf return shape are not documented where an implementer would
find them.
