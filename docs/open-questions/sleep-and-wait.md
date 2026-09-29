# Sleep / wait

Status: open, untouched since it was raised.
Last grounded: 2026-09-29 — nothing in the runtime models time.

Is a delay a property of an edge (a `DelayedOrder` that resolves later), a
special node type, or a runtime concern outside the node model entirely?

Ties into the "nothing polls, only origin nodes introduce nondeterminism" rule:
**a wait is a kind of origin.**

Nothing has pressed on this yet. Worth noting it is the one open question with no
evidence behind it — every other entry here was surfaced by building something or
by an outside reader trying to use weir for real.
