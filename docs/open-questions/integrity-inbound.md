# Classification says what may not go out; nothing says what may not be trusted coming in

Status: open.
Last grounded: 2026-09-29 — `FieldDef.classification` is still a single
open string with no direction; `classificationsOf` still computes a meet only.

## The question

Found by asking the sibling pressure-test project what its real boundaries look
like, immediately after building field-level classification against an invented
example.

The design assumed a boundary has one obligation: don't send sensitive data
across it. The real one crosses in **both directions** — and there the outbound
half was fine while the inbound half was broken. Strings fetched from
third-party county GIS services are concatenated into the DOM unescaped, so a
hostile value in an upstream field executes in the viewer.

Same edge, same boundary, two obligations: **confidentiality outbound, integrity
inbound.**

weir models only the first. `classification: pii` means "this is sensitive to
emit"; nothing expresses "this arrived from somewhere untrusted and must be
validated before it reaches a sink".

## Why it is not the same lattice run twice

Confidentiality **meets** — a compound is as sensitive as its *most* sensitive
field, which is what `classificationsOf` computes. Integrity **joins** — a
compound is as untrusted as its *least* trusted field. One walk cannot produce
both, so this is not a parameterization of the existing query.

## Not decided

- A label carrying a direction (`classification: { out: pii, in: untrusted }`).
- Two independent label sets over one edge set.
- **Integrity belongs to the *origin*, not the field.** The interesting one:
  Principle 0 already says origins are where the outside world gets in, and
  foreign data enters exactly where nondeterminism does. This would be the same
  boundary wearing a different hat, and it would make "untrusted" a property
  something *acquires by provenance* rather than one an author asserts per field
  — which also matches how taint actually propagates.

## Related

Both halves are undermined by the same newer finding: a serialized field carries
no labels at all, in either direction — see
[serialization erases classification](serialization-erases-classification.md).
Deciding direction without deciding that first would build a second query with
the same blind spot.
