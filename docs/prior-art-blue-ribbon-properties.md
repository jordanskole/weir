# Prior art: blue-ribbon-properties

[blue-ribbon-properties](../../blue-ribbon-properties) (BRP) is a sibling project, in flight,
not built with weir and not yet a candidate to migrate — weir isn't ready for it. It's kept
here because its schema design, worked out independently under real domain pressure, keeps
landing on shapes weir is also arriving at. Read the same way as design-history.md's bankql
section: not "weir should copy this," but "an independent line of reasoning hit the same wall
and here's what it did about it" — signal about which of weir's open questions are real.

**Status note:** as of 2026-08-27, BRP is direction-and-spec only — `docs/superpowers/specs/
2026-08-27-packages-schema-design.md` and its paired `docs/superpowers/plans/
2026-08-27-packages-schema-implementation.md` describe `packages/schema`, but no code exists
yet (no `packages/` directory in the repo). Everything below is design intent, not verified
runtime behavior — update this file once the package is actually built and its golden tests
run for real. Expect this whole document to need revisiting as BRP changes; it's an in-flight
project, not a frozen reference.

## What BRP is measuring against

Per BRP's `README.md`: a data layer over Michigan vacant-land parcels, structured as **two
layers that must not merge** — this repo emits measurements only (`dry_acres = 6.68`), a
separate parent project applies judgment and produces verdicts. The rule stated directly:
*"a verdict is a threshold someone already applied, and it destroys the information needed to
apply a different one."* Enforced architecturally, not just by convention: per
`04_ARCHITECTURE_MCP.md` (per the README's summary), the MCP tool surface defines no
verdict-returning tool at all — the boundary is the interface, not a policy sitting on top of
it. That's the same move as weir's declarations/implementation split
(design-history.md, "Acceptance gating, generalized one layer up") — the boundary does the
enforcing, so it doesn't need a second mechanism watching for violations.

## `Field<T>` — provenance and vintage as a nested struct, not a modifier

From the design spec:

```ts
type Provenance = "verified" | "aggregator" | "listing claim" | "inferred";
type VintageSourceType = "static" | "periodic" | "continuous" | "manual-confirmation";

interface Vintage {
  as_of: string;
  source_type: VintageSourceType;
  note?: string;
}

interface Field<T> {
  value: T | null;       // null is data, not an error
  provenance: Provenance;
  vintage: Vintage;
}
```

Every card field is wrapped this way — not because every field is ambiguous (`parcel_id`
isn't wrapped; it's the lookup key), but because the spike that preceded this spec found real
disagreement on the fields that matter (`acres`: Redfin 4.5 / Regrid ~4.5 / county
FeatureServer 3.755, for one PIN). The design spec states the alternatives considered and
rejected explicitly: flat sibling columns, or an EAV side-table — both rejected in favor of a
typed nested struct, because DuckDB/Parquet handle struct columns natively and it keeps
`dry_acres.value` typed while co-locating the metadata that makes the value trustworthy.

**Why this matters for weir specifically:** it's the same shape of decision as `literal:` vs.
a `nullable`-on-`bool` modifier (design-history.md, "Add a literal field type") — "does this
extra fact about a field deserve to be its own thing, or hang off an existing type as an
attribute" — and BRP landed on "its own thing" for the identical reason weir did: legibility
("is this trustworthy" should read at a glance, not hide in an attribute). Worth watching as a
candidate answer to the open question about whether weir fields ever carry more than their
bare type.

## `null` as data, with a mandatory reason

BRP's `null` isn't silence — every wrapped field that's `null` in the golden fixture carries a
`vintage.note` explaining *why* it's null: `"polygon-touch test not run in the spike — not yet
computed"`, `"spike's relief transect used the wrong line ... not a validated null"`. The spec
is explicit that `check_coverage` should report an unsourced field as not-yet-sourced, never
silently omit it.

This is one step past what weir currently has. weir's `nullable` (fields.schema.json) says a
field *may* be absent; BRP's convention says that when it *is* absent, the absence itself
needs a carrier for why. Not proposing to import this wholesale — but if a "why is this null"
open question ever comes up for weir fields, BRP already ran the experiment and the answer it
reached was "make the field wrapper rich enough to hold the reason," not "add a sibling
`_reason` field."

## `combineProvenance` — a concrete node-`Fn` candidate

```ts
function combineProvenance(...provenances: Provenance[]): Provenance {
  // returns the weakest of its inputs, order-independent, folds over N, throws on zero
}
```

A field computed from several source fields inherits the *weakest* of their provenance
(`verified > inferred > aggregator > listing claim`) — stated as an explicit ranking, not left
implicit. Pure, small, real business logic with a genuine design choice already made
(fold-over-N rather than pairwise-only) and tested against edge cases (order-independence,
zero-input throw). If BRP ever becomes a weir port, this is close to a canonical first node
body: total, no ambient state, one clear job.

## Cross-field validation as an assertion, not a type

`validateCard` checks `dry_acres.value + wet_acres.value ≈ identity.acres.value` within a
0.01-acre tolerance — but only when none of the three is `null` (an unset field skips the
check rather than failing it). That's structurally a `membrane()` call
(design-history.md, "Implement membrane(): assert a payload, then call fn") over a
multi-field edge: the assertion is data-shaped (a tolerance, a set of fields to compare), the
skip-on-null is itself a design decision made once and stated in the plan's Global
Constraints, not left to each call site to remember.

## Golden-record tests as the acceptance gate, already running by hand

The spec's testing section is unusually explicit about what the golden fixture is *for*:
values are asserted against the spike's own re-derived numbers, and there's a standing
instruction not to "fix" the test to match a disputed figure from an earlier hand-written
property file — *"that's what the test is for: catching drift in the method, not matching a
disputed number."* Fields with no validated source in the spike (`relief_envelope_to_water_ft`,
`prominence_ft`) are deliberately left out of the golden assertions rather than asserted
against a guess.

This is §10's accept-before-persist gate, run manually, before any tooling exists to run it
automatically — further evidence (alongside bankql) that the pattern isn't weir-specific
invention, it's what happens whenever a real project needs to trust generated/computed values
without re-deriving them by hand each time.

## Open threads to watch as BRP grows

- Whether BRP's `LayerDef` registry (source → geometry type → feeds, a static array with a
  lookup function) is doing the same job weir's `.edge`/`.node` declarations do, just without
  the name — worth another pass once `packages/schema` actually has code, the way the bankql
  comparison was done against real source rather than a spec.
- Whether the "one PIN, one card, always — no grouping concept" decision (rejected explicitly
  because grouping is itself a judgment call) has a clean weir analogue for cardinality
  decisions on edges in general, or if it's domain-specific enough not to generalize.
- Come back to this once `packages/schema` has actual code and tests running — right now every
  claim above is sourced from a spec and a plan, not from behavior.
