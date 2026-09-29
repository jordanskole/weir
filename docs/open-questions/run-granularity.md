# Run granularity: a batch job's output has nowhere to live

Status: open.
Last grounded: 2026-09-29.

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

- [Pagination cannot be gathered](pagination-cannot-be-gathered.md) — a barrier
  for a set whose size is discovered by running.
- [Branching makes every run red](branching-makes-every-run-red.md) — the holes
  half. Real semantics are "that parcel gets a null with a note; the other 3,264
  still produce cards", and weir has no way to say that is a finished run.

The residue concept is close to what is wanted. The ask was to report it **into
the payload** rather than only to the exit code.
