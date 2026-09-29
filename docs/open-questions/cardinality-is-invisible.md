# Cardinality is invisible to a static crossing query

Status: open. Probably the cheapest thing in this directory.
Last grounded: 2026-09-29.

One centroid crossing to a state service is a public-records lookup. **3,265 of
them is disclosure of which parcels are being assembled.** `weir sys` reports the
crossing identically either way.

The width is knowable — it is the spread width, and it is in the log — so this
reads as a `sys` query that does not exist yet rather than a modelling limit.

Two things to decide if it is built: whether the width comes from the
declarations (a spread's `many` output says "N", but not which N) or from a run's
log (exact, but then `sys` stops being answerable without a run, which is
currently its defining property). The second is more useful and more expensive.

Related: it is the same shape as the planner's success-rate annotation, which is
also blocked on log statistics rather than on declarations.
