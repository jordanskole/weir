# `correlation_id` origin and lifetime for multi-invocation threads

Status: open.
Last grounded: 2026-09-29 — `correlationId` is still supplied by the host per
`runNetlist` call; nothing mints or threads it across calls.

## The question

Surfaced by a sibling project's two-call agent-tool pattern: one external trigger
produces an edge; a second, genuinely separate external trigger needs `allOf:`
to find it, which only works if both invocations resolve against the same
`correlation_id`.

The existing assumption — a fresh external trigger always mints a fresh
`correlation_id` — was reasoning aimed at ruling out loop-shaped recurrence
*within* one invocation, not a considered decision about multi-call threads.

Not decided: whether `correlation_id` can be caller-supplied (an agent or
tool-runtime passing the same session identifier across calls) rather than
always framework-minted, and what its lifetime is — one request, or a whole
tool-calling session. Nothing already decided blocks either answer.

## A candidate found outside weir

`mental-museum`'s answer: identity minted by the earlier node's own payload.
It sidesteps `correlation_id` entirely in favour of a node-minted id carried as
ordinary payload data, with once-only consumption enforced by node logic.

That leaves its own thread open: whether the lookup it implies
(`SetupId -> SetupRecord`) has to be an ordinary node and edge to keep "effects
are data" intact, or is a legitimate exception.
