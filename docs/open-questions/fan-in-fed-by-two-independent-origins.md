# A fan-in fed by two independent origin nodes never fires

Status: resolved (2026-09-25, the run root).
Last grounded: 2026-09-29.

## The question

Grouping an `allOf` node's candidates by nearest common ancestor requires the
candidates to *have* one. An origin instance's `causationIds` was always `[]`,
so two instances descending from two **different** origin nodes shared no
ancestor at all — not merely the wrong one. No lineage group ever formed and the
fan-in silently never ran.

Not contrived: `design.md` §5 explicitly blesses that topology — *"there is
exactly one call to the graph's outer membrane per external event, and every
origin-shaped edge it declares needing resolves from that single payload at
once."* One event, several origin-shaped edges, is a named-legitimate shape.

## What resolved it

[The run root](../superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md).
One `Run` instance per run, appended before any node fires, cited by every
origin's output, so ancestry is **total**. `examples/recipe`'s identity-shaped
`gatherIngredients` workaround was deleted.

The caveat this entry flagged — that the root would become a pairing free-for-all,
immune to the hold rule because two different origin *nodes* are not peers —
turned out real, and needed its own rule rather than the hold: **at an ancestor
with no envelope, only its direct children group.** An envelope records an
invocation and nothing invoked the root; two instances descending from it through
intermediate invocations share only having happened in the same run, which is not
a reason to pair them.

So ancestry stayed one mechanism, as the entry predicted, but it took two rules.

It also surfaced a latent bug that had been *unreachable* rather than absent: the
hold rule compared the producing **node** where it needed the producing
**firing**, so the several edges one `allOf`-output invocation emits were treated
as peers and held each other out forever. Before the run root they had no common
ancestor to be held out of, so nothing could reach it.
