# The declared integer widths are not enforced

Status: resolved (2026-10-01 — enforced, and it found a live overflow).
Last grounded: 2026-10-01.

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

The emitter was left **stricter** while this was open, with the divergence
enumerated in `emit-zod.test.ts` as a test written to fail the day the gap closed.
The two divergence directions are not equally safe: stricter means an implementer
writes a value satisfying the declared width and the membrane accepts it, while
looser would let an implementer put `999` in a `uint8`, see a local green and a
gate green, and land it in the durable log.

## RESOLVED the same day

`validationErrors` now enforces the declared width and integerness, reading
`INTEGER_RANGES` — which moved to `types.ts` beside `SCALAR_TYPES`, so the four
readers (`membrane.ts` enforcing, `emit-zod.ts` emitting, `define.ts` checking a
`validations` range against it, `generate.ts` sampling within it) share one table
instead of the two that existed while this was being written.

**It fails rather than truncating.** Truncation would be a membrane that silently
rewrites data, and it would break replay determinism — the value in the log would
not be the value the caller produced.

**Enforcing it immediately exposed a live overflow.** `birthday` increments a
`uint8` age; the generator probes the boundary at 255; `256` is not a `uint8`. Seven
tests across `accept` and `fuzz` went red with
`result matched neither the declared output nor Failed<In>: {"age":256}`. That node
had been producing an out-of-range value at its boundary for as long as the fixture
has existed, invisibly, because the width was decorative. The fixtures now decline
at the ceiling, which is the correct answer and is what the membrane records as
`Failed<In>`.

The emitter's recorded divergence became an agreement test, as it was written to.

One gap the agreement test could not have caught, now covered separately: a
generator producing out-of-range integers would be rejected by *both* the membrane
and the emitted schema, so the two would agree and the test would pass. A separate
check asserts generated integers are within the declared width.

## What it cost, against what was predicted

Predicted, and true: **a payload that ran yesterday fails today.** That was the
point, and it landed as seven red tests naming a real overflow rather than as
anything subtle.

Predicted, and true: **the reason strings changed.** Two new ones —
`"age must be an integer (uint8), got 1.5"` and
`"age must be within uint8 range 0..255, got 256"` — which reach the `Failed`
envelope and the trace.

Predicted as a real question, and decided: **fail, not truncate.** A membrane that
silently rewrites data is wrong on its own terms and breaks replay determinism.

Not predicted: **two copies of the bounds table already existed.** `define.ts` had
`INTEGER_RANGES` (read by `generate.ts`, and already used to reject a `validations`
range wider than the type at authoring time) and the emitter had added its own. The
fix consolidated both into `types.ts` rather than adding a third.

Also not predicted: **`define.ts` was already doing half of this.** It validated
that a declared `validations` range fell inside the type's representable range — so
authoring-time checking existed and runtime checking did not, which is why the gap
was easy to miss by reading rather than probing.

## Related

- [generator coverage](generator-coverage.md) is why this hid for so long: the
  generator produces well-formed values, so no generated case ever probed *past* a
  width — it probes the boundary, which is how the `birthday` overflow surfaced the
  moment enforcement arrived. The same gap made four of the emitter's and
  scaffold's own tests vacuous until explicit probes were added.
- `datetime` has the same shape of problem and is still open: `types.ts` calls it
  an ISO-8601 string, `membrane.ts` checks only that it is a string, and no
  declaration uses it. The emitter matches the membrane there rather than
  diverging, and nothing is exercising the gap.
- [the deterministic scaffold](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md)
  is what found this, by emitting the declared range as a schema rather than a type.
