# Should `weir check` report output fields no property constrains?

Status: open.
Last grounded: 2026-10-01 — raised by `parcelCentroid`; sharpened the same day by
two tautologies the proposed check would have missed.

## The observation

`parcelCentroid` computes `lng` and `lat`. Its sole declared property is:

```yaml
- name: the centroid lies within the boundary's bounding box
  expr:
    eq:
      - get: output.pin
      - get: input.pin
```

The name describes containment. The expression compares PINs and never mentions
`lng` or `lat`. A candidate returning `{lng: 0, lat: 0}` on unparseable input is
accepted because of this (see
[the gate rewards fabrication](the-gate-rewards-fabrication.md)).

## The proposal

weir cannot tell a weak property from a strong one — that is undecidable in
general and not what this asks. It *can* answer a narrower, purely syntactic
question: **which declared output fields does no property's expression reference?**

For `parcelCentroid` the answer is `lng` and `lat` — the two fields that are the
entire point of the node. That report would have flagged this node without
understanding anything about geometry.

## Why the author wrote it that way, which matters for the fix

The property language is `lit get eq ne lt lte gt gte add sub and or not implies`.
Bounding-box containment needs the geometry parsed out of a `utf8` string, array
indexing over a coordinate ring, and a min/max fold. None exist. The real
property was **inexpressible**, so the author wrote the strongest available check
and named it after the one they wanted.

So coverage reporting alone would produce a warning the author could not have
acted on. It is useful anyway — a warning that says *"nothing constrains `lng`"*
is true and worth knowing even when the remedy is out of reach — but it is only
half an answer, and shipping it without the other half would train people to
ignore it.

## Undecided

- **Warning or error.** A node with an unconstrained output field is extremely
  common and often fine (a passthrough field, a tag). As an error this is
  unusable; as a warning it risks becoming noise.
- **What counts as "referenced".** A field read on the input side of an
  `implies` guard is not really constrained. A field inside a `not` may or may
  not be. Naive path-collection over-reports coverage.
- **Whether the property language should grow instead.** Array indexing and a
  min/max fold would make the real property writable, and then coverage
  reporting would have teeth. That is a larger change and wants its own
  question — it also interacts with
  [properties over collections](properties-over-collections.md).
- **The separate problem that a property's `name` is unchecked prose the gate
  prints as if it were the check.** Nothing reconciles the two, and the gate's
  output (`property "the centroid lies within the boundary's bounding box" did
  not hold`) reads as though the named check ran. No mechanism suggests itself
  that does not amount to checking prose against code.

## 2026-10-01: coverage would have missed the worse instances

Rendering the slice's properties as source turned up two **tautologies** —
`eq: [output.provenance, output.provenance]` and `eq: [output.pin, output.pin]` —
which hold for every possible output and cannot fail.

**The coverage check proposed above would have reported both as covered**, because
`output.provenance` and `output.pin` are mentioned. So coverage is a weaker signal
than it looked: it detects a field no property *names*, not a field no property
*constrains*, and the gap between those is where both real defects lived.

What did catch them is narrower and decidable in one comparison: an `eq`/`ne` whose
two operands are syntactically identical. That is now refused at elaboration
(`assertFalsifiable` in `property.ts`), and it is a different check from this one
rather than a replacement — a property can be non-tautological and still constrain
nothing the name implies, which is `parcelCentroid`'s case and still open.

A third candidate, between the two in strength: **a property that reads no
`input.*` path at all** cannot relate output to input. Both tautologies and
`parcelCentroid`'s PIN check would be flagged — but so would `acres is strictly
positive`, which is a legitimate output-only invariant. So it is a warning at best,
and it needs a way to say "this one really is output-only."
