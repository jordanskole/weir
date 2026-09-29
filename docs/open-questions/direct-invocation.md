# Should a node ever be invoked directly, or is that just a one-node topology?

Status: open.
Last grounded: 2026-09-29.

`invokeWithInput` exists so a caller can run one node against a supplied bag,
outside any graph — the path `fuzz.ts`, `accept.ts`, `replay.ts` and an agent
tool call all take. The alternative is that there is no such thing as direct
invocation: you build a one-node topology in memory and run it, the supplied
values arrive as origin payloads, and every instance gets a real envelope.

## What makes it more than tidiness

**Two separate bypasses exist only because staged instances have no envelope,
and both would disappear.** The arc rule treats an envelope-less instance as
eligible by type alone, since it has no producer to check against the wiring.
The lineage join needs a second tier for the same reason, since an instance with
no lineage cannot be grouped by nearest common ancestor. Neither is wrong; both
are the same concession made twice.

**Corrected during `allOf`-joins-by-lineage's final review:** this used to say
both bypasses are "load-bearing for the tool-calling path rather than merely for
tests". True of the arc-rule bypass and **not** of the join's second tier — that
spec removed the staging that would have carried a tool call into `joinRows`, so
the tool-calling path no longer reaches the tier at all.

## Where it gets real

`runNetlist` takes `originPayloads` keyed by **node** name, while an `allOf` node
needs several **edges** satisfied at once — which is exactly §5's "every
origin-shaped edge it declares needing resolves from that single payload at
once", so the model already allows it and the shape does not yet express it.

Also unresolved: whether a pulse loop per tool call is acceptable overhead, and
whether running candidates through the full runtime changes what the acceptance
gate is actually testing.

This is the same thing [quiescence and declared ends](quiescence-and-declared-ends.md)
left behind: "a topology is a node" is true of the declaration and not yet of the
machinery.

Related: [`correlation_id` lifetime](correlation-id-lifetime.md) becomes concrete
rather than hypothetical if a tool call mints a real envelope, because then it
has to belong to some run.
