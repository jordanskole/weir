# `Log` is doing two jobs under one interface

Status: resolved (2026-09-28).
Last grounded: 2026-09-29.

`Log.append` both recorded what a node actually emitted — provenance-carrying,
an envelope attached — and staged inputs so an `allOf` node's readiness check had
something to find. That second use is why `envelope` had to be optional: a
staged input has nothing to attach. One interface quietly stood in for two kinds
of entry, and a durable store would have made the ambiguity permanent rather
than per-process.

**Resolved by [the durable-log spec](../superpowers/specs/2026-09-26-a-log-that-outlives-the-process.md) §3.**
`Log.stage()` is distinct from `append()`, and `LoggedInstance.staged` is an
explicit marker that persists, so a reloaded log can still tell a staged input
from an emission whose envelope could not be built. The arc rule's bypass keys
on the marker; an envelope-less *emission* is now ineligible rather than
admitted on a technicality, since its producer is unknown.

The matching changes in `joinRows` are unreachable — the arc rule filters first
— and are labelled as such in the code rather than left looking load-bearing.

## A related half that went stale before it was fixed

This entry also recorded that `tryFire` rebuilt an `allOf` bag with its own
`log.latest` loop, duplicating a read the membrane performed internally, so the
two could drift. **That double read no longer exists**: `allOf` joins by lineage
stopped the membrane resolving `allOf` inputs at all — it takes the bag as an
argument and only asserts it. The hazard is absent rather than dormant.
