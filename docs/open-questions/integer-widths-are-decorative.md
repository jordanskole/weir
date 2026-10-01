# The declared integer widths are not enforced

Status: open.
Last grounded: 2026-10-01 — found by the zod emitter's agreement test on its
first run, then confirmed directly against `assertPayload` for all six widths.

## The observation

A field declared `uint8` accepts `-5`, `1e9` and `1.5`.

```
uint8    above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
uint16   above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
uint32   above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
int8     above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
int16    above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
int32    above max: ACCEPTED   below min: ACCEPTED   non-integer: ACCEPTED
```

`membrane.ts`'s `typeofFor` maps every numeric type to `"number"`, and
`validationErrors` enforces only an explicit `validations: { min, max }`. So the
width in `type: uint8` is documentation, and an `age: uint8` field with no
`validations` block is exactly `number`.

This is the project's recurring pattern — a declaration claiming more than the
mechanism performs — on the type vocabulary itself.

## It is live, not theoretical

15 declaration files across 6 apps use an integer type: ages, review scores, oven
temperatures, vertex and ring counts. `uint32`, `int8`, `int16` and `int32` are
declared in the vocabulary and used by nothing, so four of the six widths have
never been exercised at all.

## Why it surfaced now

The zod emitter
([the deterministic scaffold](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md))
maps `uint8` to `z.number().int().min(0).max(255)`, because a schema is exactly
the artifact that keeps a declared range where a TypeScript type discards it. The
agreement test then compared the emitted schema against `assertPayload` and found
the membrane was the looser of the two.

The emitter is deliberately **left stricter**, with the divergence enumerated in
`emit-zod.test.ts` as a test that fails when this is fixed. The two divergence
directions are not equally safe: stricter means an implementer writes a value
satisfying the declared width and the membrane accepts it, while looser would let
an implementer put `999` in a `uint8`, see a local green and a gate green, and
land it in the durable log.

## The fix, and what it costs

`validationErrors` gains the width bounds and an integer check, derived from the
type rather than from `validations` — the bounds are already written down in
`emit-zod.ts`'s `INT_BOUNDS` and should move somewhere both can read, since two
copies of this table is the drift class this repo keeps hitting.

Not done yet because it changes behaviour in a load-bearing module:

- A payload that elaborated and ran yesterday may fail today. That is the point,
  but it should be a deliberate change rather than a side effect of building an
  emitter.
- `assertPayload`'s reason strings feed the `Failed` envelope and the trace, so
  new messages are observable in logs and in whatever asserts on them.
- Whether a non-integer in an integer field should fail or truncate is a real
  question. Failing is almost certainly right — silent truncation is how a
  parcel's acreage becomes wrong by a foot — but it is a decision.

## Related

- [generator coverage](generator-coverage.md) is why this hid for so long: the
  generator produces well-formed values, so no generated case ever probed a
  width. The same gap made two of the emitter's own tests vacuous until explicit
  probes were added.
- `datetime` has the same shape of problem and is milder: `types.ts` calls it an
  ISO-8601 string, the membrane checks only that it is a string, and no
  declaration uses it. The emitter matches the membrane there rather than
  diverging twice.
