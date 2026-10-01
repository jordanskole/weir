# Run granularity: a batch job's output has nowhere to live

Status: open.
Last grounded: 2026-10-01 — both original blockers now shipped; one new, narrower one named.

The pressure-test's real job is **17,839 parcels producing one artifact**. Two
framings, neither of which works:

**Per-parcel.** 17,839 runs, and the artifact write is a fold across correlation
ids — so it is *not a weir node at all*. `output`/`terminals` describe the end of
one parcel, not the end of the job: a run that "finishes" 17,839 times having
produced nothing anyone actually wanted.

**Per-corridor.** Fits the shape well, except one failed lookup out of 3,265
leaves residue and kills the whole run.

The reporter's own answer was **one run per corridor**, and that weir cannot
express it — *not* because of correlation ids, but because a corridor run needs a
gather that tolerates holes.

## What it is actually blocked on

Both of the blockers this entry was written with have shipped:

- ~~Pagination cannot be gathered.~~ **Resolved 2026-09-29** by
  [`gather … until`](../superpowers/specs/2026-09-29-gather-until.md): a cycle's
  barrier is the arrival of its terminating branch, not a count.
- ~~Branching makes every run red.~~ **Resolved 2026-09-29.** The shape actually
  modelled for "a null is data" — `oneOf: [Found, Unavailable]` with a handler
  each — no longer reports a stall, so a corridor run where some parcels take the
  unavailable branch finishes clean.

**What remains is one narrower thing**, and it is a question about `gather`
rather than about run granularity:
[a gather is all-or-nothing](gather-is-all-or-nothing.md). A genuine `Failed_*`
among 3,265 elements still kills the whole group, because `sequence`'s signature
says one element's failure is the whole result's. A corridor run therefore
finishes cleanly when parcels are *expectedly* absent and produces nothing when
one *unexpectedly* fails.

The residue concept is close to what is wanted. The ask was to report it **into
the payload** rather than only to the exit code.
