# Quiescence is not success

Status: (a) implemented; (b) specified but not built — see §4.

## Motivation

A run that stalls and a run that finishes report the same thing.

```
stopped: "quiescence"   firings: 3   failures: []
```

That is the result of this program, which does not work:

```
explode (Seed -> many Item)          two items spread
  look (Item -> oneOf[Looked, Skipped])   item "a" -> Looked, item "b" -> Skipped
    summarizeAlert (gather Looked -> Summary)
```

`Skipped` is not a failure. "This entity is not applicable" is an ordinary
routing decision, and nothing consumes that branch, which is also ordinary. But
the gather is now waiting for two `Looked` and will only ever see one. No
`Summary` is produced, no `Failed_*` is logged, one `Looked` sits unconsumed
forever, and `weir run` prints **`✓ quiescence` and exits 0**.

Raised 2026-09-27 by a reader given only the docs, as a general safeguard rather
than a bug report:

> When a run reaches quiescence with unconsumed inputs still waiting at a
> multi-input node, report it as an error or a Failed edge. […] Extending that
> to every run, so that "stopped without reaching an expected end state" is
> always an error, would turn this whole class of bugs from silent into loud.

**It is a sharper catch than it looks, because it finds a hole in the feature
built to prevent exactly this.** `gather`'s §4 reasoned that a group which can
never complete must fail rather than hang, since "a silent stall is this repo's
worst failure mode" — and then defined *can never complete* as "an element has a
`Failed_*` descendant". An element whose subgraph simply **ends** is invisible to
that rule. Half the ways to hang were closed and the section claimed both.

**The readme already defines quiescence as the check that is missing**, which is
the part worth being uncomfortable about:

> Termination is quiescence — **no node has unconsumed input left** — and
> bounding a runaway graph is the host's job, not the language's.

The runtime's actual rule is `firedThisPulse === 0`: *nothing fired*. That is
strictly weaker than *nothing is waiting*, and the gap between them is precisely
this bug. A docs accuracy pass the day before missed it, because it audited
which **features** existed and not which **definitions** held.

## 1. Two safeguards, and only one of them is free

The suggestion bundles two checks with very different costs. Separating them is
most of the work.

**(a) Residue.** At quiescence, a node left holding unconsumed input on a
declared arc is stalled. Derivable from what already exists — `eligibleForEdge`
computes exactly this set on every pulse — so it needs **no new declaration, no
authoring burden, and no language change**. It catches the motivating program.

**(b) Declared terminal edges.** A topology declares what reaching the end looks
like, and a run that ends elsewhere is an error. Needs a new declaration on
every root topology, and catches a **different** class: the run where everything
was consumed tidily, nothing is waiting, and the answer never appeared.

Neither subsumes the other. (a) sees a stall but cannot tell a finished run from
a run that wandered off; (b) sees the wrong destination but says nothing about
*why*. **Build (a) first**: it is free, it closes a demonstrated hole, and it
requires no decision from an author.

## 2. Residue: what counts, and what deliberately does not

A node has **residue** when, at quiescence, `eligibleForEdge` returns a non-empty
set for it on some declared input edge. That is the whole predicate. What makes
it usable is what it excludes *by construction* rather than by special case:

- **A terminal output is not residue.** `Cookies` at the end of the recipe is
  unconsumed forever, and that is the answer, not a stall. No node declares it,
  so it is eligible for nobody.
- **An unrouted `oneOf` branch is not residue.** `Skipped` above is a legitimate
  dead end. Same reason: nothing declares it as input.
- **A ragged `allOf` leftover is residue.** `joinRows` deliberately leaves
  unmatched candidates unconsumed "until their partners arrive". At quiescence
  they never will.
- **An incomplete `gather` group is residue.** Which is the motivating case.

**The population is multi-input nodes, and the predicate is general on purpose.**
A `single`-input node with an eligible unconsumed instance **at quiescence**
should be impossible: the pulse loop would have offered it as a candidate and
fired it. So if one appears there, the pulse loop dropped something, and the
check has found a **runtime bug** rather than a program bug. Writing the
predicate over every input kind rather than narrowing it to `allOf`/`gather`
costs nothing and buys that invariant.

**Corrected during the build: that invariant holds only at quiescence.** A
`budget`- or `maxPulses`-stopped run routinely leaves a `single`-input node
holding input — it was simply cut off mid-flight — and the first version of this
paragraph said "at quiescence" loosely enough to read as "always". The test for
§7 reports exactly that (`lookOrSkip needs Item`), which is correct behaviour and
would have looked like the runtime bug this paragraph describes. `stopped` is
what separates them, which is the same reason the two are reported separately
rather than collapsed into an error flag.

The scan runs once, at quiescence, over the same `scanned` set a pulse already
walks — one extra pulse's worth of work for the whole run.

**What it reports.** Enough to act on without re-running: the node, the edge, and
how many instances are waiting. A count rather than the instances themselves —
the log already holds those, and a `RunResult` that embeds payloads becomes a
second copy of the thing that is supposed to be the source of truth.

## 3. Not a `Failed` edge — a property of the run

The suggestion offers "an error or a `Failed` edge". It must not be a `Failed`
edge, and the reason generalizes.

**A `Failed_*` instance implies an invocation.** It carries an envelope; an
envelope records that a node ran; and the log is the source of truth. At
quiescence *nothing ran* — that is the definition. Minting an envelope for a node
that never fired would put a false statement in the one artifact everything else
is derived from, in order to report that something went wrong. The cure would be
worse than the disease.

This is the same wall the dead-`gather` group hit, and the resolution there does
not transfer. A dead group emits `Failed_Many_X` through the membrane with a
throwing `fn` — legitimate, because there genuinely *is* a firing: the gather
node fires, on a partial collection, and fails. Residue has no such firing to
attribute to. The distinction is worth keeping sharp: **a failure is something a
node did; residue is something the run didn't.**

So residue is reported on `RunResult`, and the host decides what it means. That
also keeps the change **non-breaking** — every existing test observes the same
behaviour and one more field — and it matches the rule already stated in §5 of
`design.md`: bounding a run is the host's job, not the language's.

`weir run` is a host, and it is someone asking "did this work", so it reports
residue and exits non-zero.

**One breaking change, taken deliberately.** `RunResult.failures` is typed
`{ node, failed: Failed<InputSpec> }[]`, is documented as "currently always
empty", and has been vestigial since the input kind that populated it was
removed. Its comment says deleting it would be "a separate public-API change" —
this is that change, and the moment its absence is actually noticed. Replace it
with `residue`. Leaving both would ship a field named `failures` that never
reports the failure the run actually had.

## 4. The root topology is the only boundary that declares nothing

(b) sounds like a new language feature. It is closer to removing an exception.

Every other boundary in weir declares its contract. A `.node` declares `input`
and `output`. A **composite** `.topology` declares `input`, `output`, and the
`terminals` whose outputs are that output — and that declaration is exactly what
makes a composite checkable against its contents at elaboration. A root topology
declares none of it: `isCompositeTopology` is literally `"input" in raw`, so the
root is the one topology that is a bag of wiring and nothing else.

Which is why nothing can say whether a run finished. There is no statement of
what finishing means.

So (b) is: **let a root topology declare its contract like every other topology
does.** `output:` names the acceptable terminal edges; a run that reaches
quiescence having produced none of them is an error. `design.md` §9 already
requires this for dynamic routing ("types prevent illegal steps but cannot compel
necessary ones") — the observation here is that the requirement was never
specific to dynamic routing, it was specific to *not having declared an end*.

Two things to settle before building it, which is why it is not in this spec's
build scope:

- **Optional or required?** Required is the honest default and breaks every
  existing example and fixture at once. Optional means the safeguard is absent
  exactly where an author didn't think about it, which is where it is needed.
  A middle path — required for new topologies, warned for old — needs a notion of
  "old" that the repo does not have.
- **Does it interact with `oneOf` terminals?** A topology may legitimately end
  several ways (`Accepted` or `Rejected`). So `output:` on a root is a *set* of
  acceptable ends, and "reached none of them" is the error — not "reached
  something other than the one".

## 5. What this still will not catch

Stated so a clean result is not read as a proof, the same way `verify`'s is:

- **A run that produced the right edge for the wrong reason.** Residue is
  structural; it knows nothing about values.
- **A node that fired and produced a useless result.** That is what examples and
  properties are for.
- **A gather whose barrier completed with the wrong members.** Lineage decides
  that, and if lineage is wrong the count can still be right.
- **Under (a) alone, a run that consumed everything and produced nothing useful.**
  That is (b)'s job, and it is the reason (b) stays on the table rather than
  being closed by this spec.

## Testing

Break-proofs required for each, recorded in the test's own comment along with
what the break-proof showed — including the ones that turn out not to redden,
since three of `gather`'s did not and saying so is the only thing that kept them
honest.

1. The motivating program — spread, a `oneOf` that skips one element, a gather —
   reports residue naming the gather node and `Looked`, with a count of 1. *Built*
   (`residue.test.ts`). Its break-proof is the one worth reading: with the scan
   disabled, every other observable is **identical** to a healthy run —
   `quiescence`, no output, no failure — and only the residue assertion reddens.
   That is the whole bug, stated as a test.
2. A run that completes normally reports **no** residue. *Built*, and it landed
   somewhere better than specced. The twelve `expect(result.failures).toEqual([])`
   assertions in `runtime.test.ts` were asserting an always-empty field; renaming
   the field made all twelve **meaningful for the first time**, and none of them
   reddened, so no existing example stalls.

   Then the gap: the four richest example runs — escalation (iteration),
   manuscript-review (a per-lineage join), and both soc-triage tests (spread and
   gather) — asserted nothing about residue at all. A comment in `residue.test.ts`
   claimed they did before they did; the fix was to add the assertions rather than
   soften the comment. What guards it going forward is not another example run but
   a check that **every root under `examples/` is asserted residue-free by some
   test**, since the failure mode is a new example silently falling off the list.
3. A terminal output is not residue. Assert specifically that `Cookies` — an
   unconsumed instance with no declared consumer — does not appear.
4. An unrouted `oneOf` branch is not residue. Same assertion for `Skipped`,
   because this is the case most likely to be over-caught.
5. A ragged `allOf` leftover **is** residue: two `Left` and one `Right` fires
   once and reports the leftover `Left`.
6. `weir run` exits non-zero and names the stalled node, where today it prints
   `✓ quiescence` and exits 0. Assert the exit code, not just the text — the
   whole point is that a script notices.
7. A run stopped by `budget` or `maxPulses` reports residue too, and is not
   confused with a stall. *Built*, and it is what produced §2's correction above.
   Break-proof: computing residue only on the quiescence exit left it empty —
   which is why all three exits now go through one `finish` helper, so a future
   exit cannot reintroduce the omission by forgetting the scan.

## Explicitly out of scope

- **(b), declared terminal edges on a root topology.** Specified above as far as
  the two open decisions; not built. Tracked in `open-questions.md`.
- **Making residue a `Failed` edge** (§3), which the log cannot honestly carry.
- **Deciding *why* a node stalled.** The report says a node is waiting and on
  what; whether the cause is a miswired arc, a `oneOf` that skips, or a node that
  never fired is a question for the reader with the log in front of them.
- **Liveness analysis at elaboration.** "Can this topology ever stall" is a
  static question, genuinely answerable for some shapes, and a different piece of
  work from observing that one run did.

## Amended 2026-09-29: a branch not taken is not a stall

This spec's §2 defines residue as *"a node still holding eligible unconsumed
input on a declared arc when the run stopped"*, and argued it excludes the
benign cases **by construction** — a terminal output and an unrouted `oneOf`
branch are declared as input by nobody, so no node waits on them.

**One benign case was missed, and it is the most ordinary branching topology
there is.** A `oneOf` feeding two mutually exclusive joins — route to one of N
handlers — leaves the loser holding its other arm forever:

```
Out produced: [{"v":"viaL"}]        ← correct
residue [{ node: "handleR", edge: "S", waiting: 1 }]
```

The output is right and the run exits non-zero. The unrouted branch is excluded
by construction; the *arm paired with* an unrouted branch is not.

**It is per lineage group, not per node pair**, which took a second fixture to
see. Put a spread above the branch and *both* joins fire correctly while both
still hold the other element's token — so neither is "the loser", and a
node-level exclusivity rule has nothing to key on. The count is also one
spurious entry per element per branch-not-taken, so a few-thousand-element
spread reports thousands of them on a correct run.

**The rule added.** A held instance is not residue when, for that instance's own
lineage, every input edge the node is missing has a `oneOf` sibling that *was*
produced. Both halves are needed and both already existed: the declarations say
which edges are siblings of one `oneOf` output, and the log says which branch
each token took.

Strict in two ways, because this suppresses the check that catches real stalls.
**Every** absent edge must be explained — a node missing both a
branch-not-taken and an arm that genuinely never arrived is still stalled, and
`some` rather than `every` hides it (tested). And at least one edge must
actually be absent, so a node that could have fired and did not stays visible as
the pulse-loop bug it would be.
