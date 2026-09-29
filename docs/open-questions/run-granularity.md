# Run granularity: a batch job's output has nowhere to live

Status: open.
Last grounded: 2026-09-29 — re-grounded after the residue fix; one of its two blockers is gone.

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
- ~~[Branching makes every run red](branching-makes-every-run-red.md) — the
  holes half.~~ **Resolved 2026-09-29.** The shape the reporter actually
  modelled for "a null is data" — `oneOf: [Found, Unavailable]` with a handler
  each — no longer reports a stall, so a corridor run where some parcels take
  the unavailable branch now finishes clean. What is *not* covered is a genuine
  `Failed_*` among 3,265 elements, which `gather`'s all-or-nothing deadness rule
  still kills: `sequence`'s signature says one element's failure is the whole
  result's. Whether a batch wants a `traverse` that tolerates failures — a
  partial collection plus a failure list — is the remaining half, and it is a
  question about `gather`, not about run granularity.

The residue concept is close to what is wanted. The ask was to report it **into
the payload** rather than only to the exit code.
