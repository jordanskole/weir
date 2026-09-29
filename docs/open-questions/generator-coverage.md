# Should the generator produce `null`, and explore cross-field combinations?

Status: open.
Last grounded: 2026-09-29 — both still true of `generate.ts`.

Neither was named in the [generator spec](../superpowers/specs/2026-09-10-generator-and-fuzz-harness.md);
both surfaced in the whole-branch review that implemented it. Neither is a defect
in what was built — both are candidate scope for a follow-up.

**`null` for nullable fields.** Arguably the canonical boundary value for a
`nullable: true` field — "the case a hand-written example set is least likely to
include", which is the spec's own rationale for boundary bias generally. Adding
it was not part of the approved design.

**Cross-field combinations.** Every field in one generated payload shares a
single `caseIndex`, so per-field boundary coverage is thorough but *combinations*
are never explored: a bool and a two-value enum on the same edge only ever see
2 of their 4 combinations, no matter how large `count` is.

`generateManyValue`'s own `caseIndex + i` fix is the visible precedent for a
general remedy, not yet generalized beyond collections.
