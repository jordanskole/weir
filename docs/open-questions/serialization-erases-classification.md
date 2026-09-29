# Serialization erases classification at exactly the crossing it describes

Status: open.
Last grounded: 2026-09-29 — reproduced on `spikes/blue-ribbon-soil`.

## The question

`Vertex` declares `classification: location` on both `lat` and `lng`. `weir sys`
reports the hop to USDA's Soil Data Access as:

```
SoilQuery  buildSoilQuery (server) -> clipSoilAtSda/fetchClippedSoilPolygons (usda-sda)  carries linkable
```

**`linkable` only.** The parcel's complete boundary geometry goes over that wire
and the query does not say so, because `SoilQuery.wkt` is a `utf8` string holding
a serialized `POLYGON((...))` and the labelled `Vertex` edge never crosses.

The labels are correct, the crossing detection is correct, and the answer is
still wrong.

## Why it is the failure mode that matters

This is a **false negative in a leakage query**. Field-level classification §4
offers `weir sys`'s crossings as §7's *"no edge carrying an unredacted PII field
may cross into a non-client zone"* made answerable, and a query that
under-reports what crosses cannot support that sentence.

It also inverts that spec's §5 redaction argument — *"a `RedactedPerson` is
simply an edge whose fields carry no classification, and the query then reports
no PII crossing, because there is none."* True for deliberate redaction. Here
nothing was redacted: the data was **encoded**, and the labels fell off in
transit.

## The structural reason

weir measures a crossing at the **node boundary**. The wire format is produced
**inside** whichever node or handler serializes. Those are not the same place,
and no amount of labelling fixes the gap on its own.

The bind, stated by the reporter: serialize in a **pure node** and it is gated
and testable but the crossing edge is an opaque string; serialize in the
**effect handler** and the crossing carries the labels but the serializer becomes
untested host code outside the acceptance gate. Neither is obviously right.

## Candidate directions, none taken

- Let an edge declare that a field *carries* another edge's shape in serialized
  form (`wkt: { serialized: ParcelGeometry }`), so classification and hashing can
  see through the encoding while the payload stays a string.
- Treat serialization as a declared node kind, with the pre-image in lineage.
- Accept the limit and have `sys` report *"this crossing carries an opaque
  field"* as a distinct finding — which converts a silent false negative into a
  visible unknown. Cheapest, and not a fix.

## Adjacent, worth deciding together

The same blind spot presumably applies to `hash.ts`: two `SoilQuery` payloads
differing only inside the serialized string are structurally identical to the
fingerprint. Correct for a `utf8` field, wrong for the geometry it stands in for.

And [integrity inbound](integrity-inbound.md) would build a second query with the
same hole if direction is decided before this is.
