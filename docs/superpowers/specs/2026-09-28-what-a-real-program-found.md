# What a real program found

Status: implemented (the four defects; the three design frictions are open questions, not built).

## Motivation

Every example in this repo is a fixture. `examples/soc-triage`'s own README says
its domain nouns are deliberately fake, and the other five are smaller still.
They were written to exercise weir, by someone who knew what weir wanted — which
makes them a poor test of whether weir survives contact with a program it did not
anticipate.

So an agent holding [blue-ribbon-properties](../../prior-art-blue-ribbon-properties.md),
the in-flight sibling project this design is already pressure-tested against, was
asked to model a slice of its ETL as weir declarations, and explicitly told **not to fight the syntax**:
where something did not fit, write what it wanted and say so. The friction was
the deliverable; the declarations were the vehicle.

The slice it chose resolves one parcel's identity — route by trust path, fetch,
normalize, find a centroid, look up a township, join the two halves. Nine edges,
seven nodes, three zones, one fan-in, three effects. It elaborates and runs.

**It found four defects in weir, all of them in code that had tests.** Each is
recorded below with what the test suite was doing instead.

## 1. `weir test` reported its own bug as the author's mistake

`resolveImplementationAt` gives an effect node a deliberately-throwing `fn`,
because the runtime performs the effect through a host handler and calling it as
an ordinary function is a bug loud enough to say so. `runExamples` skipped a node
only when `typeof fn !== "function"`. The stub **is** a function.

So an effect node's declared example was invoked, the stub threw, the membrane
caught it and turned it into a `Failed_` payload, and the example was reported as
**failed** — with `actual.reason` set to the stub's own words: *"it is performed
by the runtime's handler, never called as an ordinary Fn."* The tool printed the
explanation of its own defect in the position where it prints the author's
mistakes.

Declaring an example on an effect node was therefore a permanent red that no
amount of implementing could clear.

**The fix is a fourth outcome, not a skip.** `verify` already has exactly this
category (`declaredNondeterministic`) for exactly this reason. A skip means *not
yet implemented* and must block a green tick; an effect is never going to have an
`fn`, so counting it as a skip only moved the permanent red. It is listed, named,
and never counted as a pass — nothing was checked.

## 2. One declaration, tested twice

`inlineComposites` leaves a composite's inner nodes under two keys — the bare
`fetchDirect` and the qualified `directCountyFetch/fetchDirect` — so that a wiring
can name either. `runExamples` iterated the raw map, so every inlined node's
examples ran twice and were reported under two names.

`plan` hit this same thing when it shipped and fixed it locally with a
`distinctContracts` helper. The rule has moved to `elaborate.ts`, beside the
inlining that creates the duplicates, and both callers use it.

The two defects compounded exactly: three effect nodes, each double-counted, is
the six failures out of twelve cases the report opened with.

## 3. `weir sys` called a field-spread source orphaned

A `"...Name":` spread **copies** the source edge's fields rather than embedding
the source. After elaboration the source is a declared edge that nothing
produces, consumes or nests — indistinguishable, to `orphans`, from dead weight.
It exists precisely to be spread, and was reported as a defect for doing its job.

`EdgeDef` now records `spreadFrom`, and `orphans` honours it. Two things about
that field are deliberate:

- **It is provenance of the declaration, not of the data.** An edge written by
  spread and one with those fields typed out by hand are the same edge on the
  wire.
- **It is therefore not fingerprinted**, which happens for free because
  `fingerprint` names the keys it emits rather than spreading the edge. Replacing
  a spread with its expansion must not move a contract hash and invalidate
  accepted implementations for a change that altered no data. Pinned with a test,
  since the next rewrite of `fingerprint` could lose it silently.

This is the *second* false positive in `orphans`, and the first one's lesson
shaped the fix: the original `Address` correction over-corrected into counting
nested references from synthesized `Failed_X` edges, so nothing was ever orphaned
and the findings list read like a clean program. Every test here asserts both
directions — the spread source is excused **and** a genuine orphan is still found.

## 4. `weir run` could not execute any effectful program

`runNetlist` takes `host.effects` and refuses to start when a declared effect has
no handler. The CLI never passed one, and had no flag to supply one. So for a
framework whose stated division of labour is that **the host performs the
effects**, the shipped host could not perform any.

Nothing caught this because no example declares an effect and no CLI test ran a
program that did. The gap was exactly the size of the untested region.

`--effects <file.ts>` supplies a module default-exporting an object keyed by the
name each `.node`'s `effect:` field gives. The CLI checks up front and names what
to write, since there is nothing to copy from:

```
✗ no handler for effect(s) "http".

  An effect is performed by the host, never by a drafted implementation
  — that is what keeps every other node pure (design.md §0). Supply them
  with --effects <file.ts>, default-exporting an object keyed by the name
  each .node's `effect:` field gives:

      export default { http: async (payload) => { /* ... */ } }
```

## 5. One claim that did not survive checking

The report also said a fan-in where one input is the **ancestor** of the other
works, and that nothing documents or tests it.

The behaviour is real — verified in the run log, where `ParcelIdentity` cites a
`NormalizedParcel` from step 3 and a `TownshipLookup` from step 5 that descends
from it. But the rest is wrong: 2026-09-25-allof-joins-by-lineage.md states it
outright under *"Self counts as an ancestor"*, with the same reasoning and a
`Recipe`/`Dough` example, and `lineage.test.ts` has covered it since that spec
shipped.

**What was genuinely missing was narrower**: the existing test is origin-adjacent,
where the ancestor *is* the joined instance. No fixture drove the general shape —
an ancestor sitting mid-graph with a chain below it — through the pulse loop,
where the held-candidate rule also gets a say. That test now exists.

Recorded because the correction matters more than the finding: an outside report
is evidence, not a verdict, and this one was believed and repeated once before it
was checked.

## 6. What is deliberately not built

Three frictions blocked a real rewrite, in the report's own ordering. All three
are design decisions, not defects, and are recorded in `open-questions.md`:

- **No opaque type.** An ArcGIS response is `Record<string, unknown>` *correctly*
  — five counties, five field-name dialects. Modelled as a JSON string, it
  "parses and lies", and schema assertion, structural hashing and generated cases
  all go inert across the one hop where every real adapter bug has lived.
- **Pagination cannot be gathered.** `gather` collects instances descended from a
  single spread, and a cycle is not a spread — the page count is not known when
  the loop starts.
- **No extensible envelope.** Metadata that must survive a hop has to be a
  declared field on every intermediate edge, so the trust value was threaded
  through a node with no use for it. weir already has an envelope; it is not
  extensible.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks whose stated mechanism turned out wrong.

1. An effect node's stub is never invoked, and the example is its own category —
   not a pass, not a skip, not a failure.
2. One declaration runs once, though inlining leaves it under two keys.
3. A spread source is not orphaned, **and** a genuine orphan still is.
4. `spreadFrom` moves neither an edge's hash nor the contract hash of a node
   naming it.
5. `weir run` executes an effectful program when handlers are supplied, and the
   produced edge reaches the log.
6. It refuses one with no handlers, naming the effect and the flag.
7. It rejects an `--effects` module whose export is not an object of functions.
8. `weir test` reports an effect node's example as an effect, not a failure.
9. A fan-in joins a node with a descendant several hops down, through a real run.
