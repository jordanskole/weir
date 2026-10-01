# Should `weir check` report output fields no property constrains?

Status: open.
Last grounded: 2026-10-01 — raised by `parcelCentroid`, whose only property never
reads either of the two fields the node exists to compute.

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
