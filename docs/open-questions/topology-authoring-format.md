# `.topology` authoring format

Status: resolved (2026-09-25). Kept as a citation target.
Last grounded: 2026-09-29.

Both framing and mechanism are settled and recorded in `design-history.md`
("A join is a topology boundary", "A membrane closes on terminal markers, and a
topology-as-node is handed the log"): a single topology only fans out,
reconvergence happens at a membrane, the join sits at the producing topology's
*exit*, a repeated bare name means another instance, a composite closes on
declared terminal markers rather than inner quiescence, and a topology-as-node
resolves its inputs from the log rather than from arcs.

The one thing this held open — whether a topology-as-node sees its producer's
exports or the whole log — resolved 2026-09-25 in favour of the whole log.

Nothing is open. This file exists because `elaborate.ts`'s `Wiring` doc comment
cites it.

**Caveat, from a neighbouring question:** "a repeated bare name means another
instance" is the half of this that is *not* settled in the runtime — see
[positional identity](positional-identity.md), where it conflicts with
`examples/escalation` using a repeated name to mean a cycle.
