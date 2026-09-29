# Does `scope` subsume `allOf:`, or stay a separate declaration?

Status: resolved (2026-09-24).
Last grounded: 2026-09-29.

They are the same mechanism. Both declare a set of edges that must all be
present; `allOf:` waits for missing instances to arrive, `scope` fails
immediately as a scope-mismatch failure edge, and `scope` alone carries optional
field-level narrowing.

`allOf: [A, B]` is sugar for `scope: [read:A, read:B]` with waiting turned on
and no narrowing — not a second thing to reconcile.

Recorded in `design-history.md`, "`scope` subsumes `allOf:` — same mechanism,
`scope` just doesn't wait."

Kept for the record: that `Fn` receives only the specific fields a node's
`scope` names, never the whole edge, was already settled. The prior art was a
durable-functions auth middleware that scoped required env vars this precisely
— and notably did *not* apply the same narrowing to the authenticated-user
object it passed through, which is part of what prompted designing this more
tightly here.
