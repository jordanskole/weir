# Pagination cannot be gathered, because a cycle is not a spread

Status: open.
Last grounded: 2026-09-29 — `gather` still keys on a spread's collection token.

## The question

An ArcGIS fetch loops until the server stops setting `exceededTransferLimit`.
Cycle-as-recursion expresses the loop, and is arguably *nicer* than the `while`
— every page becomes a logged, replayable token.

But `gather` collects instances descended from a single **spread**, and the page
count is not known when the loop starts, so there is nothing to spread over.
There is no way to say "gather everything this cycle produced".

**An ETL that cannot rejoin its pages has not done anything.**

## Why it is structural rather than a missing convenience

`gather`'s barrier works because [the collection token records the
count](gather-and-the-vectorized-consumer.md). A cycle has no collection token
and no count — that is what makes it a cycle. So this is not "add a gather
variant"; it is "what is the barrier for a set whose size is discovered by
running".

## The candidate offered, not designed

`effectCardinality: many` — the host is permitted to be chatty, the log stays
per-element, and the topology shows **one** crossing. That would also give retry,
backoff and pagination a place to live.

The counter worth weighing: one node per fetch is wrong (3,265 log entries for
one field), and one node hiding 3,265 fetches is also wrong — it hides chattiness
at exactly the place Principle 0 says to expose it, and replay then feeds back
one opaque blob instead of per-page results.

## Related

This blocks the run-granularity question: the real job is thousands of parcels
producing one artifact, and the reporter's own answer was "one run per corridor,
and weir can't express it" — blocked on a gather that tolerates a discovered
count and, separately, on one that tolerates holes. See
[branching makes every run red](branching-makes-every-run-red.md) for the holes
half.
