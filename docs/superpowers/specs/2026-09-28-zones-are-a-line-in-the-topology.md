# Zones are a line in the topology

Status: implemented (placement and crossings; classification is §3, not built).

## Motivation

`design.md` §7 opens:

> **Zones** annotate where a node runs — client, server, third-party, log. The
> topology is unchanged; edges crossing a zone boundary are the network hops.

Zero lines of it exist. And the first sentence implies the wrong mechanism: *"zones
annotate where a **node** runs"* reads as a field on every `.node`, repeated across
every node in a subgraph that all run in the same place.

**Decided 2026-09-28: a zone is a line in the topology.** A `.topology` already
declares where a unit begins (`input`), where it ends (`output`, `terminals`) and
what it contains (`wiring`). Where it *runs* is the same kind of fact about the
same unit, and putting it there means placement is declared once for a subgraph
rather than repeated on each of its nodes.

The rest of §7 is unchanged by this and in fact reads better: *"the topology is
unchanged; edges crossing a zone boundary are the network hops"* — a crossing is
now an edge between nodes declared in differently-zoned topologies, which is a
lookup rather than an analysis.

## 1. Optional, unlike the other topology keys

`input`, `output` and `terminals` are required, because every topology has a
beginning, an end and something that produces it. **`zone` is optional**, and the
asymmetry is deliberate: most programs have no placement concern at all, and a
required `zone: default` on every `.topology` in the repo would be ceremony that
teaches nobody anything.

An unzoned topology's nodes are **unzoned**, not "in some default zone". The
difference matters at the boundary: an edge between an unzoned node and a zoned
one is not a crossing, because nothing was claimed about where the first one runs.
Inventing a default would manufacture crossings nobody declared.

## 2. A node's zone is its declaring topology's

`investigate/investigateIdentity` runs wherever `investigate` runs. That is
already recoverable after inlining, because the qualified key records which
topology the node came from — a property `inlineComposites` has had since
composites shipped, for unrelated reasons.

Two consequences worth stating rather than discovering:

- **A node declared in no topology has no zone.** It has no placement because it
  has no position.
- **The same node wired into two differently-zoned topologies has two zones**,
  one per inlined instance, which is correct: it genuinely runs in two places.
  Its *contract* is one thing and its *placements* are two, which is the same
  shape as a composite referenced twice getting `#1` and `#2`.

## 3. What a crossing is, and what it is for

An edge **crosses** when a node in zone `A` feeds a node in zone `B`. That is the
network hop §7 names, and it is what makes the rest of §7's argument checkable
rather than aspirational — *"no edge carrying an unredacted PII field may cross
into a non-client zone"* is a query over crossings, once fields carry
classification labels.

**This spec does not build classification.** Labels on fields are the other half
of §7 and a separate decision: what the label vocabulary is, whether it is closed,
and whether it lives on a field or an edge. Crossings without labels are still
worth having — `weir sys` can report where the network hops are, and the planner
can count them per route, which is one of §8's five annotations and the only one
still missing that is buildable at all.

## 4. Reported by the two queries that already exist

**`weir sys`** gains zones on the edge listing and a crossings section: which
edges are network hops and between which zones. It stays a report rather than an
error, for the reason it already does — a crossing is a fact about the design, not
a defect.

**`weir plan`** annotates each route with its crossings, completing §8's
annotation list to the extent the declarations allow: depth and effectful already
ship, crossings arrive here, `lossy` cannot exist yet (2026-09-28-the-planner.md
§4) and success rate needs runs.

## 5. What this deliberately does not decide

- **Whether a node may override its topology's zone.** Plausible — one node that
  must run server-side inside a client subgraph — and unnecessary until something
  needs it. Adding it later is a field; taking it away would not be.
- **What a zone *is* beyond a name.** §7's client/server/third-party/log are
  examples, not a closed set, and nothing here validates against a vocabulary.
  A closed set is easy to add and impossible to remove.
- **Field-level classification** (§3), the other half of §7.
- **Anything about execution.** A zone is recorded and queried; no runtime
  behaviour changes, and in particular nothing stops a node running anywhere.
  §7's leakage rule is a *static query*, and this is the half that makes it
  expressible.

## Corroboration from a real codebase

Asked after the fact what its boundaries actually look like, the sibling
pressure-test project supplied an argument for declaring a zone that this spec
had only asserted: two of its county adapters route their queries through a
**commercial third-party proxy** rather than to the county directly, behind an
interface identical to the direct adapters. Nothing in the types distinguishes
them — same signature, same shape, different trust boundary.

So a zone genuinely cannot be inferred from the data or the contract. It has to
be declared, by somebody who knows where the code runs. That is the case for
§1's design rather than a nice-to-have, and it arrived from outside rather than
from reasoning about the examples in this repo.

## What the build found

**`declaredIn` had to be recorded rather than derived.** §2 says a node's zone is
recoverable from the qualified key, since inlining records which composite a node
came from. Half true: an *entry's own* nodes carry no prefix, so the key alone
cannot say where they were declared. The elaborator records the mapping instead,
which also handles `anyOf` shadows without a second rule.

**A guard that looked load-bearing was unreachable.** Crossings skip an edge whose
*producer* is unzoned — and no fixture exercised it, because the obvious test
(#7) only covers zoned→unzoned. The break-proof came back green. Added the
symmetric case, an unzoned node feeding a zoned one, which is the direction that
would otherwise invent a boundary from a single declaration.

**`examples/soc-triage` is now zoned, and the answer is the argument.** The
per-entity investigation is placed `third-party` and the alert pipeline `server`,
which makes the four network hops fall out: `Entity` leaving twice, and the two
contexts coming back. That is §7's *"edges crossing a zone boundary are the
network hops"* as a query rather than a sentence — and it required no change to
the topology's shape, which is §7's other claim.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A `.topology` declaring `zone:` elaborates, and its nodes report that zone.
2. A topology declaring none leaves its nodes unzoned — **not** defaulted.
3. An inlined composite's nodes take the composite's zone, not the entry's. The
   case the whole per-topology design rests on.
4. A node wired into two differently-zoned topologies has both placements, one
   per instance.
5. A crossing is reported between two differently-zoned nodes, naming both zones.
6. An edge between two nodes in the **same** zone is not a crossing.
7. An edge between a zoned node and an unzoned one is **not** a crossing —
   nothing was claimed about where the unzoned one runs, so no boundary was
   declared to cross.
8. `weir plan` annotates a route with its crossings, and a route within one zone
   reports none.
9. Every example still elaborates. Five declare no zone at all — the guard
   against an optional key becoming accidentally required — and `soc-triage`
   declares two, which is what exercises the crossings.
