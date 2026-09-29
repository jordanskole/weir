# `gather … until`: a barrier for a set discovered by running

Status: implemented.

## Motivation

An ArcGIS fetch loops until the server stops setting `exceededTransferLimit`.
Cycle-as-recursion expresses that well — better than the `while` it replaces,
because every page becomes a logged, replayable token — and then the pages
cannot be rejoined.

`gather` collects instances descended from a single **spread**, and the page
count is not known when the loop starts, so there is nothing to spread over.
**An ETL that cannot rejoin its pages has not done anything.**

The open question stated the problem as *"what is the barrier for a set whose
size is discovered by running?"*, which is the right question and contains a
wrong assumption: that a barrier must be a *count*.

## 1. The spread's barrier does not transfer, and should not

`gather`'s barrier works because the collection token records the count:
completeness is *"N instances descend from this collection, where N is its entry
count"*. A cycle has no collection token and no count — that is what makes it a
cycle rather than a fan-out.

The two are different in kind, not in degree:

| | spread | cycle |
|---|---|---|
| shape | **parallel** — N branches, any order | **sequential** — each step needs the last |
| size known | when the spread fires | only when it stops |
| barrier | the count | **the terminator** |

## 2. A cycle is sequential, so its terminator is a sound barrier

This is the whole spec, and it is checkable rather than asserted.

A cycle iterates because each iteration's input **descends from the previous
iteration's output** — `Page₁ → Req₂ → Page₂ → … → Pageₙ → Done`. So by the time
the terminating branch appears, every prior element already exists *and is an
ancestor of it*. Nothing can still be in flight, because a cycle has only one
thread of descent.

Verified on a four-page loop before this spec was written:

```
pages: 0,1,2,3   done: {"cursor":"4"}
pages among Done ancestors: 0,1,2,3
ALL pages are ancestors of the terminator: true
```

So the barrier is not a count at all. It is **"the terminator exists"**, and the
membership rule falls out of it: *every instance of X among the terminator's
ancestors*. Both halves already exist — `ancestorsOf` walks lineage transitively,
and the terminating branch is a token the cycle must already produce, or it would
not terminate.

That a *parallel* fan-out cannot use this rule is the same fact from the other
side: a spread's elements are not ancestors of one another, so there is nothing
whose arrival implies the rest.

## 3. The declaration

```yaml
# collectPages.node
input:
  gather: Page
  until: Done
output: AllPages
```

`until:` names the edge whose arrival closes the barrier. Read as: *gather every
`Page` this cycle produced, which is every `Page` the `Done` descends from.*

An ordinary `gather` keeps its meaning unchanged — this is one optional key, and
a `gather` without it is still the spread's count-based barrier. Two barriers,
because there are genuinely two shapes.

**A gathered element still needs an `index`**, as it always has, and here that is
not a tax: a page has a page number. This is exactly the case
[keyed-versus-ordered collections](../open-questions/keyed-versus-ordered-collections.md)
distinguishes — a page number is a *natural* key, unlike a log line's, so nothing
synthetic is invented and the collection stays keyed rather than positional.

## 4. Why not `effectCardinality: many`

The candidate the pressure test offered: let the host be chatty, log per element,
show one crossing in the topology. **Rejected**, and the reasoning is the report's
own.

One node per fetch is wrong — 3,265 log entries for one field. One node *hiding*
3,265 fetches is also wrong, and worse in the way that matters: it hides
chattiness at exactly the place Principle 0 says to expose it, and replay then
feeds back one opaque blob instead of per-page results, so a paging bug becomes
unreplayable at the granularity it occurs.

`until:` keeps every page a real token — logged, replayable, individually
attributable — and costs one declaration key rather than a new effect kind.

## 5. What it does about failure, which is `gather`'s rule unchanged

A group whose elements include a `Failed_*` fails as a whole under
`Failed_Many_X`, exactly as a spread-gathered group does: `sequence`'s signature
says one element's failure is the whole result's, and nothing about a cycle
changes that.

A cycle that **never terminates** produces no terminator, so the barrier never
closes, the gather never fires, and the host's `budget` stops the run — which
then reports the waiting gather as residue. That is the correct outcome and needs
no new rule: an unbounded loop is bounded by the host, which is where weir has
always put it.

## 6. Explicitly out of scope

- **A terminator that is not in the cycle's lineage.** `until:` means "the
  ancestor-closing token", not "any instance of this edge anywhere". Two
  concurrent cycles in one run are separated by lineage, which is tested; a
  terminator produced *outside* the cycle is a different feature and probably a
  mistake.
- **Ordering the collection by iteration.** It is keyed by the element's own
  `index`, like every collection. A page number sorts, but the collection does
  not promise order, and the open question about ordered collections is
  unchanged by this.
- **`effectCardinality`** (§4), and retry/backoff generally, which that proposal
  also wanted a home for. They still need one.
- **Cycles whose element count *is* known up front.** Those are a spread.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A four-page cycle gathers all four, keyed by page number, when the terminator
   arrives — the motivating case, end to end.
2. **The gather does not fire early.** With three of four pages produced and no
   terminator, nothing fires. The assertion the whole barrier rests on.
3. A cycle terminating immediately gathers the **empty** collection, which falls
   out of the rule rather than needing a case.
4. Two concurrent cycles in one run gather their own pages and not each other's —
   lineage separates them, and this is what `until:` means by "the terminator's
   ancestors" rather than "any terminator".
5. A cycle whose element fails produces `Failed_Many_X`, as a spread-gathered
   group does.
6. A non-terminating cycle leaves the gather waiting and is reported as residue
   once the budget stops the run — not as a silent success.
7. An ordinary `gather` with no `until:` is unchanged, and still uses the
   count-based barrier. The guard against this quietly replacing the other rule.
8. `until:` naming an edge no node produces is refused at elaboration, like a
   gather with no spread above it.
9. Every existing example still elaborates and runs, and no contract hash moves
   for a node that declares no `until:`.

## What the build found

**Rule C would have rejected every paging loop.** `assertWiringTypes` requires a
spread above *every* gather — *"with no spread above it there is no count to fire
on and it would never fire"* — which is exactly right for the count-based barrier
and exactly wrong for this one. A cycle-gather has no spread by construction.

It was invisible to four passing tests, because each built its program directly
and so never went through `elaborate`. Found only by writing the declarations out
as real files and running `weir check`. A fifth test now takes that path, and its
break-proof is the rule firing.

The counterpart rule is the same question asked of the other shape: a terminator
**nothing upstream produces** means the barrier can never close, so it is refused
at elaboration rather than never firing at runtime.

**The paging loop needs a seed node**, and that is a known limitation rather than
a surprise here: an origin can never iterate
(`docs/open-questions/an-origin-node-can-never-iterate.md`), so `fetchPage`
cannot be both the entry point and the looped node. The first fixture written for
this spec hit it immediately and produced one page and no terminator.

**Two schema edits, not one.** `until` had to be added to the *input* branch of
the node schema as well as to the parser and the type — the fourth instance of
the pattern `declaration-round-trip.test.ts` was written for, and the first one
that test did not catch, because `until` lives inside `input`'s shape rather than
being a top-level `NodeDef` key. That test's reach stops at the top level, which
is worth knowing about it.
