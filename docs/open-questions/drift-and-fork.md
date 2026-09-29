# Drift at a boundary, and forking a run to act on it

Status: resolved (2026-09-29). Two sub-questions inside it stay open.
Last grounded: 2026-09-29.

## Where it came from

The "no opaque type" friction, which turned out to be the wrong question. weir
already asserts every effect handler's result against its declared output edge,
so the boundary *is* validated. What is missing is that `assertPayload` checks
only **declared** fields and passes undeclared ones through into the durable log
— making an edge a lower bound rather than `design.md` §1's "complete description
of what crosses a wire", and making
[classification unsound](serialization-erases-classification.md) on every typed
edge rather than only opaque ones.

## Built 2026-09-29

All of it: stripping in `logOutput`, `undeclared` on the envelope, the raw
result kept in the trace on the failing path, and `weir fork`.

## What the spec proposed

Strip undeclared fields from the log, record their names on the envelope (values
already reach the trace), and add `weir fork` — re-execute a recorded run under
*current* declarations into a **new** run, with every effect pinned to the
parent's recorded result. The log is never mutated.

Two properties make an agent loop over candidate schemas viable: a fork is
**deterministic**, and it needs **no effect handlers or credentials**.

## Still undecided inside it

- **A per-edge strict mode** that rejects undeclared fields instead of stripping.
  Additive later; nothing needs it yet.
- **Whether a fork can ever be reconciled back into its parent.** There is no
  merge, and it is not obvious there should be one.
- `undeclared?: string[]` would be the first extensible envelope field — see
  [extensible envelope](extensible-envelope.md), which is the precedent worth
  setting deliberately.
