# Positional identity: `birthday.then.birthday` should run twice

Status: **blocked** — two shipped things use the same syntax with opposite
meanings.
Last grounded: 2026-09-29 — `examples/escalation` still wires `triage: then:
triage`; `examples/recipe` still names `bake` twice.

## The question

Two *mentions* of one node in a `.topology` should be two distinct instances, and
`Wiring`'s flat parent→children adjacency map cannot represent the difference
between "run it three times" and "run it forever" once nested YAML collapses into
it. `netlist.ts` already emits `${nodeName}#1` ids that nothing makes meaningful.

Not data-driven iteration: this terminates **by construction**, where iteration
terminates by quiescence.

## Why it is blocked

An earlier note called this unblocked and "a build task". **That was wrong, and
by a sharper conflict than the diamond it cited.** Checked before building:

- `examples/escalation` wires `triage: then: triage` — a node feeding **itself**,
  the cycle that drives iteration. It runs repeatedly until its `oneOf` base case,
  and it is tested.
- `design.md` §3 holds that `birthday.then.birthday` is *"a legitimate distinct
  application, not a cycle"* — it should run **twice**, as two instances.

Giving `Wiring` positional instance identity turns escalation's cycle into
`triage#1 -> triage#2` and breaks it. The diamond was never the hard part; the
**self-reference** is, and moving joins to topology boundaries did nothing about
it. `examples/recipe` also still names `bake` twice as a flat diamond, so the
claim that composites removed the need is not true of the corpus either.

## A candidate, not taken

**Make instance identity explicit rather than positional.** An author writes
`birthday` twice to mean the same node — a cycle, or a diamond's two parents —
and `birthday#2` to mean another instance, reusing the `#n` convention
`inlineComposites` already mints for a composite referenced from several sites.

That removes the ambiguity rather than resolving it by precedence. It costs a
sentence in `design.md` §3, which currently says the bare repeat *is* the
distinct application.

Recorded so the next person does not discover the conflict by breaking
`escalation`.
