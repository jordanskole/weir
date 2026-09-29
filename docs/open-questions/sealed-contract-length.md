# Is the sealed contract's length a cost nobody is accounting for?

Status: open.
Last grounded: 2026-09-29 — `exportContract` still includes each edge's full
`description`.

The pressure-test's edge files carry long argued prose — one edge's description
alone runs to **1,578 characters**. That prose is *good*, and descriptions are
where it belongs rather than in `#` comments the YAML parser discards.

But it ships verbatim to every isolated agent drafting an implementation against
that contract, on every draft, and nothing budgets for it.

Undecided whether that wants a length cap, a `description` versus `brief` split,
or nothing at all — the contract being complete is the point, and truncating it
to save tokens would be trading the feature for the cost of the feature.

Related: [prose on node declarations](prose-on-node-declarations.md) asks whether
prose should be *required*. If it ever is, this question becomes load-bearing
rather than incidental.
