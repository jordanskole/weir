# Which parts of a node declaration are contract, and which are commentary?

Status: open for `examples`. The `scope` half closed 2026-09-24.
Last grounded: 2026-09-29 — `fingerprintNode` still excludes `examples`, per its
own doc comment.

## The question

Surfaced putting property assertions in the contract hash — precisely to avoid
an implementation sitting accepted against a strengthened invariant it was never
checked against. That made two existing omissions look like an inconsistency
rather than an oversight.

## The `scope` half, closed

`scope` is fingerprinted, because it is **behavioural**: it feeds
`narrowIdentity`, so it decides what data `Fn` actually receives. Change
`read:Identity:sub` to `read:Identity:iss` and, unhashed, the accepted
implementation resolves unchanged and reads `env.identity.sub` as `undefined`,
silently, with acceptance declining to re-check because the hash says nothing
changed. Replay made it worse: the drift refusal is only as good as
`fingerprintNode`'s coverage, so a widened `scope` passed the check, resolved the
same pinned implementation, and replayed "successfully" with the new field
simply absent.

The stated reason for deferring — "changing what's in the hash shifts every
existing accepted hash" — turned out vacuous on inspection: no `implementations/`
tree existed and no accepted artifact lived outside a test's temp directory, so
there was nothing to shift and the fix cost nothing.

## Still open: `examples`

They stay out of the hash deliberately — *"examples gate acceptance, they don't
define the hash being accepted against."* The asymmetry with `scope` is the
point: `examples` is a **verification** artifact, not behaviour.

The consequence is still real. Adding an example does not invalidate an accepted
implementation, so an implementation can sit marked accepted while an example it
was never run against sits in its contract. That **weakens a gate rather than
corrupting a result**, which is why it did not ride along with `scope`.

Undecided: whether the weakened gate is acceptable long-term, or whether
acceptance should re-run examples against an already-accepted implementation
without re-deriving its hash — a third option keeping the hash meaning "the
contract" while closing the hole.
