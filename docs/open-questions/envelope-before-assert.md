# Should `membrane()` build the envelope before asserting input?

Status: resolved (2026-09-24 — build it first).
Last grounded: 2026-09-29.

## The question

The envelope was built *after* the input assert, so a rejected input returned
`Failed<In>` before any envelope existed — hence "present iff `Fn` actually ran".
Clean, and it gave the trace a precise meaning: it recorded *invocations*, never
attempts.

The cost was observability, and larger than it first appeared. A rejected input
produced **no trace entry** and a `Failed_*` instance with **no provenance** —
shaped exactly like a *staged* input, which is supposed never to happen for a
real emitted instance. Two failures that look identical in the log had opposite
provenance depending on whether `Fn` ran, distinguished only by the *absence* of
provenance: a real signal, but an accidental one.

## What resolved it

`buildEnvelope` runs before `assertPayload` in both branches, and
`Invocation.envelope` is non-optional — an envelope exists for every **attempted**
invocation. `LoggedInstance.envelope` stays optional; that is a genuinely staged
input with no invocation behind it, a different case.

Three costs taken as intended rather than avoided:

1. **Error precedence flipped.** A node with both a bad `scope` and a bad input
   now reports the scope error. Judged correct: a bad `scope` is a declaration
   bug (the node is malformed regardless of input), a bad input is a runtime
   condition (the node is fine, the data is not) — matching the project's split
   between declaration bugs, which throw, and implementation failures, which are
   collected.
2. `hashNode` runs for every input about to be rejected. The price of a real
   `contractHash` on every attempt.
3. **The trace records attempts**, so a trace entry no longer implies `Fn` ran to
   completion. `tryFire` already had that looseness — a rejected input already
   counted as a firing — so this made the trace agree with the runtime rather
   than introducing a new inconsistency.

One case still has no envelope: `buildEnvelope` itself throwing. Nothing was
built, so there is nothing to record, and the two `undefined` guards stay in
place for exactly that case rather than becoming unconditional.
