# The `sys` queries

Status: draft.

## Motivation

The readme calls this half of weir *"the other half, and the one most frameworks
skip"*:

> A weir program is not a pile of files an agent has to reconstruct meaning from
> — the topology, the ontology, and the log are all data, so the framework ships
> queries over them: what edges exist, what refines what, what is unreachable or
> orphaned, which nodes are cut vertices, which paths bypass a given node.

None of it ships. `weir graph` prints the wiring; there is no other query, and
`grep` finds no implementation of any of the five — only comments. `design.md`
§6 was corrected during the docs audit to say so plainly rather than imply
otherwise, and §8 remains an entire section with nothing behind it.

**Two of the five are newly answerable, which is part of why now.** Until
topologies declared `terminals`, an edge produced and never consumed could not be
told from *the answer*: `Cookies` sits unconsumed forever and that is the point.
With declared terminals, "produced by a terminal" and "produced and then dropped"
are different facts, and only one of them is a defect. The same declaration makes
cut-vertex and bypass analysis meaningful, because both need a *destination* and
until last week a program had no declared one.

## 1. What each query actually means

Four of the five are unambiguous. One has never been defined anywhere, and
defining it is most of this section's work.

**`edges` — what exists, and who touches it.** Every declared edge with the nodes
that produce and consume it. Trivially derivable and the least interesting alone;
it is the index the other answers are read against.

**`refines` — what refines what.** Never defined in any doc. `design.md` §2 says
refinement is how a decision survives: *"A node that makes a branching decision
must emit distinct edges: `Person -> one of {Child, Female, Male}`"* — so the
relation is exactly that shape.

**Resolved: `X` refines `Y` when some single-input node takes `Y` and emits `X`
as one branch of a `oneOf` output.** Narrow on purpose:

- `allOf` output is **fission**, not a decision — every branch fires, so nothing
  was decided and nothing is refined.
- `many` output is **cardinality**. An `Entity` is not a refinement of an `Alert`.
- A node whose *input* is `allOf` refines nothing, because there is no single
  thing the decision was made about. Recorded rather than guessed at: a
  `oneOf` output over a bag could reasonably be said to refine either input or
  neither, and picking one by accident would put a wrong edge in the ontology.

That definition makes `person-birthday`'s `Pass`/`Fail` refinements of `Person`
and leaves `soc-triage`'s `Entity` correctly *not* a refinement of `Alert`.

**`orphans` — declared and unused, or produced and dropped.** Two distinct
findings that were one before terminals existed:

- **Orphaned**: an edge no node produces *and* no node consumes. Dead weight in
  the ontology.
- **Dropped**: an edge some node produces, nothing consumes, and which is *not* a
  declared terminal output. Before, indistinguishable from the answer.

A `Failed_*` edge nothing routes is deliberately **not** reported. Every node can
emit one, so unrouted failures are the norm rather than a finding, and reporting
them would bury the two above in noise.

**`mediation` — cut vertices and bypasses, which are one computation.** A node
`N` **mediates** a path when removing it disconnects some terminal from some
origin that could previously reach it. A path from an origin to a terminal that
does *not* pass through `N` is a **bypass**. Both fall out of one reachability
walk with `N` removed, so they are one implementation reported two ways.

This is the query `design.md` §7's type gate is argued from — *"You cannot call
`charge_card` without an `AuthorizedPayment`, and only `authorize` mints one"* —
turned from a claim a reviewer checks by reading into an answer.

## 2. Reported, and readable by both audiences

`weir sys [dir] [--node <name>] [--json]`.

Bare, it reports the ontology-level answers: edges with their producers and
consumers, the refinement relation, orphans and drops. With `--node`, it reports
mediation for that node — what it mediates and what bypasses it — because that
question is *about* a node and reporting it for every node at once is a matrix
nobody reads.

`--json` for the same reason `weir graph` has it: the readme's argument is that
an agent reads this, and an agent reads JSON. The human form is the default
because the other half of the argument is that a person reviews the ontology and
the topology, which §6 calls the two highest-risk artifacts.

**A finding is not an error.** `weir sys` exits 0 with findings. An orphaned edge
may be a genuine mistake or an edge declared ahead of the node that will use it,
and the difference is not decidable here — unlike `check`, `test` and `run`,
which all answer a yes/no question and exit accordingly.

## 3. The planner is deliberately next, not now

`design.md` §8 calls the planner *"the important one"*, and this spec does not
build it. The reason is sequencing rather than difficulty.

`plan(from, to)` is type-directed search *annotated with observed success rate
drawn from the log* — log statistics are the cost model, the way `ANALYZE` is for
a query planner. That cost model needs runs of a real program to be worth
anything, and this repo has none: `design.md` §10 says so outright, and
`soc-triage`'s own README says its domain nouns are deliberately fake. A planner
ranked by statistics gathered from fixtures would be a planner ranked by noise,
and the temptation would then be to add a heuristic weight to make it look
sensible — which is exactly what §8 forbids: *"weights must remain statistics,
not parameters."*

The type-directed *search* half could be built today and is genuinely useful
without the ranking. Recorded as the obvious next piece rather than folded in
here, so that the decision to ship an unranked planner is made deliberately.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. `refines` reports `Pass`/`Fail` as refinements of `Person` in
   `examples/person-birthday`, and reports **nothing** for `soc-triage`'s
   `Alert -> many Entity` — the case the narrow definition exists to exclude.
2. `refines` reports nothing for an `allOf` output, which is fission rather than
   a decision.
3. `orphans` reports an edge nothing produces or consumes.
4. `orphans` distinguishes a **dropped** output from a declared terminal one: the
   same program, one edge reported and `Cookies` not. The query that was
   impossible before terminals were declared.
5. `orphans` does not report unrouted `Failed_*` edges, which would otherwise be
   most of the output.
6. `mediation` finds a node every origin→terminal path crosses, and reports no
   bypass for it.
7. `mediation` finds a bypass in a diamond where one arm skips the node, and
   asserts the bypassing path is named.
8. Every example answers every query without throwing — the guard against an
   analysis that only works on the shape it was written against.
9. `--json` emits the same findings as the human form, so neither can drift into
   reporting something the other does not.

## Explicitly out of scope

- **The planner** (§3), including the unranked type-directed search half.
- **Zone crossings**, which §8 lists among a plan's annotations. Zones are
  unbuilt (`design.md` §7), so there is nothing to count.
- **Log-derived statistics** of any kind (§3).
- **`refines` over an `allOf` input** (§1), recorded as undecided rather than
  guessed.
