# The idiomatic way to branch makes every such run red

Status: resolved (2026-09-29).
Last grounded: 2026-09-29 — reproduced on a four-node fixture, then again with a
spread above it.

## The question

A node whose output is `oneOf: [L, R]` feeding two mutually-exclusive joins
produces exactly the right answer **and** reports a stall:

```
stopped: quiescence   firings: 3
Out produced: [{"v":"viaL"}]
residue [{ node: "handleR", edge: "S", waiting: 1 }]
```

`handleR` holds an unconsumed `S` — consumption is per-node, so it got its own
turn at the token — and waits forever for an `R` that `split` chose not to emit.
The residue check reports that as unconsumed input at quiescence, and `weir run`
exits non-zero. **The correct program is indistinguishable from a broken one**,
and routing to one of N handlers is the most ordinary branching topology there is.

## It is worse with a spread above it, and that kills the obvious fix

Two items, one routed to each branch, and *both* joins fire correctly — yet both
still report residue:

```
Out: [{"v":"L:a"},{"v":"R:b"}]
residue [{ node: "handleL", edge: "Item", waiting: 1 },
         { node: "handleR", edge: "Item", waiting: 1 }]
```

`handleL` consumed `Item(a)` with `L(a)` and fired, then holds `Item(b)` forever
because `b` went to `R`; `handleR` mirrors it. So **neither node is "the loser"**
— exclusivity is per *lineage group*, not per node pair — and the count is one
spurious entry per element per branch-not-taken. A 3,265-element spread over a
two-way branch reports thousands of them on a fully correct run.

That kills the fix first proposed here — *"teach the residue check that two nodes
fed by the same `oneOf` are mutually exclusive"* — which would suppress genuine
stalls and has nothing to key on in the case above.

## The rule, and it is built

A node waiting on edge `E` for lineage group `G` is not residue when, for that
same `G`, a sibling branch of the `oneOf` that produces `E` was taken.

Both halves were needed and both already existed: the *declarations* say `L` and
`R` are siblings of one `oneOf` output, and the *log* says which branch each
token took. More than the "already in the declarations" this entry first
claimed, though neither half had to be invented.

Built 2026-09-29 as `explainedByBranch` in `runtime.ts`, and recorded as an
amendment to
[quiescence is not success](../superpowers/specs/2026-09-27-quiescence-is-not-success.md),
whose §2 claimed the benign cases were excluded by construction. The unrouted
branch was; the arm *paired with* an unrouted branch was not.

Alternatives not explored, and no longer needed: letting a node declare it is
one of a mutually-exclusive set, or dropping branch-not-taken tokens from
residue wholesale.

## Why it matters beyond tidiness

It is the current answer to "a null is data" — a legitimate absence routed as
`oneOf: [Found, Unavailable]` with a handler each. That shape is correct, runs,
and is red. The reporter's words: *"it is expressible, it is correct, and it is
indistinguishable from a broken run."*
