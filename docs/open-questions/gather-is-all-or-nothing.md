# A gather is all-or-nothing, and a batch wants partial success

Status: specced, not built — `2026-10-01-gather-settled.md`, status draft.
Last grounded: 2026-10-01 — split out of
[run granularity](run-granularity.md), whose other two blockers both shipped.

## The question

A gather whose group contains a `Failed_*` descendant fails as a whole, under a
synthesized `Failed_Many_X`. That is not an accident — `gather` **is**
`sequence`, and `sequence`'s signature says one element's failure is the whole
result's:

```
t (f a) → f (t a)
```

There is no `f (t a)` for "most of them worked".

**And a batch job wants exactly that.** The pressure-test's real workload is
~3,265 parcels per corridor producing one artifact, and its stated semantics are
*"that parcel gets a null with a note; the other 3,264 still produce cards"*. One
failed lookup currently kills the group, so the corridor produces nothing.

## Why the obvious workaround is not enough

A node can route a legitimate absence as `oneOf: [Found, Unavailable]` and both
branches can be handled — that shape works, and since 2026-09-29 it no longer
reports a false stall. So *expected* absence is already expressible.

What is not is **unexpected** failure: a node that throws, a response that fails
assertion, an effect handler that times out. Those produce `Failed_X`, and no
amount of declaring can convert them into an `Unavailable` the author
anticipated — which is the point of `Failed_X` existing.

## Specced 2026-10-01, and the barrier already generalized

[`gather … settled`](../superpowers/specs/2026-10-01-gather-settled.md), and the
shape was not what this entry assumed — nor what the spec's own first draft
assumed.

`gather`'s barrier is *"every element resolved"*, and "resolved" has always meant
*"produced an instance of the declared edge"* — a set of exactly one. So the rule
was never "all or nothing"; it was **"every element resolved to a declared
outcome"**, and widening that set is the whole feature. Today's behaviour falls
out as the degenerate case rather than sitting beside a second mechanism, which
is the main reason to believe the shape is right.

Tolerance has to be **named in the contract** — no threshold, no implicit
acceptance of `Failed_*` — because a gather that silently absorbed failures makes
"3,264 of 3,265 succeeded" indistinguishable from "3,265 succeeded", which is the
shape of every quiet data-loss bug.

It also turned out not to be only about failure: the same widening is what lets a
legitimate absence routed as `oneOf: [Found, Unavailable]` be gathered, which is
two **success** edges and the case a failure-specific `tolerating:` would have
missed. One mechanism, two cases.

The two rejected candidates and why: a tolerance threshold turns a judgement into
a number with no home in a contract, since a node cannot know what fraction its
*caller* finds acceptable; and reporting residue into the payload answers "what
did not finish" rather than "what failed".

## What this is not

Not the dead-group rule being wrong. `gather`'s all-or-nothing behaviour is
correct *for a gather*, and was built deliberately to stop a group hanging until
the budget. The question is whether weir also needs the other operation, beside
it, with a different signature and a different name.

**And the first draft had the node receive both edges, which was wrong.** Jordan's
objection — *a node should take a single input; branching lives in the topology* —
corrected it: `settled:` widens **what closes the barrier**, never what the node
receives. The partition happens in the wiring, as two single-input gather nodes
sharing one barrier. [Diagram](../superpowers/specs/2026-10-01-gather-barrier.html).

That correction is also what killed `partition:` as the keyword, which had been
the leading candidate: the node does not partition, the topology does.
