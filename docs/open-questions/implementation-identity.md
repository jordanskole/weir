# The version pin pins the contract, not the implementation

Status: partly resolved (source text, 2026-09-27). Open for identity that is not
source text.
Last grounded: 2026-09-29.

## The question

Raised asking how a probabilistic box satisfies Principle 0. **That part needs
no change:** a classifier with fixed weights is a deterministic function whose
output happens to express doubt, so it is an ordinary node; genuine
nondeterminism (sampling above temperature zero, a hosted model that moves under
you, an unseeded training run) is an **effect** — emitted as data, performed by
the runtime, recorded — and downstream of the record everything is pure again.
A model call is a primitive: opaque inside, sealed outside.

**What it surfaced instead was a gap in the pin.** `readme.md` and `design.md`
§10 claim an invocation records the implementation version it ran under.
`Envelope` recorded `contractHash` and nothing else, and the accepted file lived
at `{node}/{short(contractHash)}.ts` — one path per *contract*. Re-accepting a
different implementation of the same contract overwrote it, so replay resolved
whatever was on disk now. It pinned the contract and called it a version.

A model-backed node makes that reachable with nobody doing anything wrong: swap
the weights and the behaviour changes with no contract change, so the hash is
identical, the path is identical, the drift check passes, and the replay
"succeeds" against a different function.

## What resolved the source half

`resolveImplementationAt` hashes the implementation's source text
(`hashSource`), the membrane records it as `Envelope.implementationHash`, and
`replayInvocation` refuses an entry whose recorded hash differs from the file on
disk. An entry recorded before the field existed replays as before — an absent
hash is not evidence of drift.

The payoff is that `weir verify`'s mismatches became *attributable*: a changed
implementation arrives as a refused replay with a reason rather than as an
indistinguishable mismatch, so what is left when a replay completes and
disagrees is the node itself.

## What is still open

**Implementation identity that is not source text.**

- An **effect node has no accepted artifact** — its behaviour is a host handler
  — so it carries no implementation hash, and a handler swapped between runs is
  invisible.
- The **model-backed case is the same shape one level out**: hashing the source
  of a node that *calls* a model does not capture the weights it called, so a
  retrain still replays "successfully".

Candidates unchanged: a weights-or-endpoint-version hash contributed by the
implementation itself, or folding implementation identity into the stored path
so two implementations of one contract coexist rather than overwrite. Note that
`metadata.ts`'s `computeImplementationMetadata` already derives facts from
implementation source and is deliberately kept *out* of the hash as a
side-channel — this question is the opposite one, whether identity belongs in.

**Newly relevant (2026-09-29):** [fork](../superpowers/specs/2026-09-29-drift-and-fork.md)
pins every effect to the parent run's *recorded result*, which sidesteps handler
identity for replay — but also means a fork cannot notice that the handler it is
standing in for has since changed. Same gap, now load-bearing for a second
feature.

## Related, and cheaper to act on

A probabilistic node cannot be pinned by exact `examples`, which fix one model
version and break on every retrain. Its contract leans on `∀ p . …` properties
instead — the label is in the enum, the probabilities sum to one, the output is
stable under a transformation that should not matter. That is an argument the
property mechanism is load-bearing for this class of node, not a nicety.
