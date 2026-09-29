# Quiescence is not success, and a root topology declares no end

Status: resolved (2026-09-28, both halves).
Last grounded: 2026-09-29.

## The question

Raised by a reader given only the docs, as a safeguard rather than a bug report:
a run reaching quiescence with unconsumed input still waiting should say so. It
found a hole in `gather`'s §4, which closed one of the two ways to hang and
claimed both — an element whose subgraph produces a `Failed_*` is caught; an
element whose subgraph simply *ends* is not.

## What resolved it — part one, residue

[Quiescence is not success](../superpowers/specs/2026-09-27-quiescence-is-not-success.md).
A node still holding eligible unconsumed input when the run stopped is reported
on `RunResult.residue`, and `weir run` exits non-zero naming it. Not a `Failed`
edge, because an envelope records that a node *ran* and at quiescence none did.

It replaced `RunResult.failures`, which had been always-empty since the input
kind that populated it was removed — so twelve tests asserting `failures` was
empty became meaningful for the first time.

Two things the build settled: the "a `single`-input node with residue means the
pulse loop dropped something" invariant holds **only at quiescence**, since a
budget-stopped run routinely leaves one holding input. And the four richest
example runs asserted nothing about residue at all, so what guards it now is a
check that *every* root under `examples/` is asserted residue-free by some test.

## What resolved it — part two, declared ends

[A root topology declares its end](../superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md),
then [a topology declares its beginning](../superpowers/specs/2026-09-28-a-topology-declares-its-beginning.md),
which **deleted the root/composite distinction**: every `.topology` declares
`input`, `output`, `terminals`, `wiring`, and whether one is an entry point is
*derived* from whether another references it. A root was never a different kind
of thing — it was a composite nobody had referenced.

The required-or-optional question turned out to be the smaller half. The obvious
formulation — a root declares `output:` — is a **false green on two of six
examples**. `manuscript-review` leaves two edges unconsumed and only one is the
success condition. `todo-list` leaves none: its nodes are rhombus-shaped, so
every edge type is both intermediate and terminal, and `output: TodoList` would
be satisfied by an intermediate emitted three pulses earlier.

Hence the pair: **`terminals:` (node names) alongside `output:` (edges)**. The
runtime half asks for an instance of the declared output whose `envelope.node`
is a declared terminal, which is what defeats the rhombus.

Terminals cannot be inferred: `escalation` is cyclic so leaf-detection finds no
leaf, and a leaf is structural where a terminal is semantic.

## What it did not resolve

Direct invocation and the two bypasses. Routing the acceptance gate through a
full pulse loop would change what the gate tests. So **"a topology is a node" is
true of the declaration and not yet of the machinery** — see
[direct invocation](direct-invocation.md).

The residue check itself has since been found to fire on correct programs — see
[branching makes every run red](branching-makes-every-run-red.md).
