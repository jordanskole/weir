# Iteration, and the "no loop construct" claim

Status: resolved (2026-09-26, in four specs).
Last grounded: 2026-09-29.

## The question

`design-history.md` and `design.md` §3 held that weir has no loop construct and
needs none — a repeated node name in a `.topology` is "a legitimate distinct
application, not a cycle". An outside reader tested that against the code in
2026-09-24 and found the runtime did not implement it: `fired: Set<string>`,
keyed by bare node name, meant a node appearing twice fired **once, silently**.

## What resolved it

The diagnosis was wrong in its first two framings, and the corrections are the
useful part:

1. The blamed `fired: Set<string>` was the *second* problem. `InMemoryLog` kept
   one instance per `(edgeName, correlationId)` and `append` overwrote — so even
   with firing identity fixed there were no distinct instances to key on.
   Latest-wins was the banned ambient mutable cell, living in the runtime.
2. "No loop construct" conflated a construct with a capability. `while` needs
   ambient state; recursion does not. A node feeding itself with a `oneOf` base
   case was already the recursive form.

Settled as a Petri net: fire once per unconsumed instance, consumption tracked
per node, `allOf` joined by shared lineage rather than a declared key, iteration
bounded by the host rather than the language. Built in four pieces:

- [the log becomes a log](../superpowers/specs/2026-09-24-instance-retention-and-iteration.md)
- [causation is real](../superpowers/specs/2026-09-24-causation-is-real.md)
- [`allOf` joins by lineage](../superpowers/specs/2026-09-25-allof-joins-by-lineage.md)
- [composite nodes](../superpowers/specs/2026-09-26-composite-nodes.md)

The narrative belongs to `design-history.md`, "Iteration: it's a Petri net, and
the loop was never the missing piece", and is not repeated here.

## What it left behind

Three separate questions, each with its own file — this entry closing does not
close them:

- [an origin node can never iterate](an-origin-node-can-never-iterate.md)
- [a fan-in fed by two independent origins](fan-in-fed-by-two-independent-origins.md)
- [there is no fan-out primitive](no-fan-out-primitive.md)
