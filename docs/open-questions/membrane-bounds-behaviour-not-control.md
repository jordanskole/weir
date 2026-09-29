# The membrane bounds behaviour, not control — `fn` is still directly reachable

Status: open.
Last grounded: 2026-09-29 — `NodeDef.fn` is still a public field (`types.ts:588`).

`membrane(nodeDef, ...args)` no longer hands out a detached invoker — it used to
return a callable the caller invoked later, so "invocation only happens through
the membrane" was enforced by every call site happening to comply rather than by
the structure. That closed one gap and left the larger one.

`fn` is a public field on `NodeDef`, and `implementation.ts`, `fuzz.ts` and
`accept.ts` all pass whole `NodeDef`s around, so nothing prevents calling it
directly and skipping the assert, the envelope and the `Failed<In>` conversion.
**The membrane's guarantee is "if you call me, these things happen" rather than
"these things happen".**

Making it structural means `fn` not being readable from the type consumers hold
— resolution constructs it, nothing else can reach it — which touches how
implementations are resolved and handed to the runtime, and how the fuzz and
acceptance paths invoke candidates.

Not attempted. Recorded because the gap between what the name claims and what the
code enforces is exactly the kind of thing that stops being obvious once the
shape looks right.
