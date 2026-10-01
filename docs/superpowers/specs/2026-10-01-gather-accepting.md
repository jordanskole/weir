# `gather … accepting`: partition, beside sequence

Status: draft.

## Motivation

`gather` **is** `sequence`, and its signature is why one element's failure is the
whole result's:

```
sequence :: t (f a) → f (t a)
```

There is no `f (t a)` that means "most of them worked". That behaviour is correct
*for a gather*, and was built deliberately so a group fails rather than hanging
until the budget.

**And a batch job wants the other operation.** The pressure test's real workload
is ~3,265 parcels per corridor producing one artifact, with stated semantics
*"that parcel gets a null with a note; the other 3,264 still produce cards"*. One
unexpected failure currently kills the group and the corridor produces nothing.

The operation wanted is not `sequence` but **partition** — in Haskell's
vocabulary `separate`, over a `t (Either e a)`:

```
partition :: t (f a) → (t a, t e)
```

Different signature, different name. This spec adds it beside `sequence` rather
than changing it.

## 1. The barrier already generalizes; only the accepted set was fixed

`gather`'s barrier is *"every element of the spread resolved"*, and "resolved"
has always meant **"produced an instance of the declared edge"**. An element that
produced a `Failed_X` resolved to something outside that set, so the group is
dead.

Which means the rule was never "all or nothing". It was **"every element resolved
to a declared outcome"**, with a declared set of exactly one. Widening the set is
the whole feature:

```yaml
# summarizeCorridor.node
input:
  gather: ParcelCard
  accepting:
    - Failed_ParcelCard
output: CorridorSummary
```

**Today's behaviour is the degenerate case, not a parallel mechanism.** With no
`accepting:`, the declared set is `{ParcelCard}`, a `Failed_ParcelCard` falls
outside it, and the group dies exactly as it does now. That the existing rule
falls out of the new one unchanged is the main reason to believe this shape is
right.

## 2. Tolerance is named in the contract, or it does not happen

An author must write the edge they will tolerate. There is no threshold, no
`tolerant: true`, and no implicit acceptance of `Failed_*`.

That is the point rather than ceremony. A gather that silently absorbed failures
would turn "3,264 of 3,265 succeeded" into a result indistinguishable from
"3,265 succeeded", which is the shape of every quiet data-loss bug. Naming
`Failed_ParcelCard` in the contract means the reader of the declaration knows
partial results are possible, and `weir sys` can see it without running anything.

## 3. It is not only about failure

The same widening covers a case the pressure test raised separately, which is why
one mechanism is better than a failure-specific one.

A legitimate absence is routed as `oneOf: [TownshipLookup, TownshipUnavailable]`
— *"a null is data"*, two **success** edges, neither a failure. Spread over
parcels, each element resolves to one of the two, and gathering them today is
impossible for the same reason: the declared set holds one edge.

```yaml
input:
  gather: TownshipLookup
  accepting:
    - TownshipUnavailable
```

A failure-specific `tolerating:` would not have covered this, and the two cases
would have grown separate machinery for one question.

## 4. The payload becomes a bag, and only when it has to

With no `accepting:`, `Fn` receives the collection it receives today — a map
keyed by each element's `index`. Unchanged.

With `accepting:`, it receives a **bag keyed by edge name**, each value a
collection:

```js
{
  ParcelCard:        { "10-003": {...}, "10-004": {...} },
  Failed_ParcelCard: { "10-009": { input: {...}, reason: "..." } }
}
```

Shape following the declaration is established here — a `oneOf` output is tagged
where a `single` is not, an `allOf` input is a bag where a `single` is not — so
this adds no new idea. And it is the shape the body wants: a summary iterates the
successes and reports the failures, which are two different loops.

**A `Failed_X` has no `index`**, since its payload is `{input, reason}`. It is
keyed by the **failed element's** index, read from `input`, so a caller can line a
failure up against the element that produced it. Where the index cannot be
recovered, the instance id is the key — the same fallback the ordinary gather
already uses.

## 5. Asymmetry between `gather:` and `accepting:`, deliberately

`gather: X` names what the author *wanted*; `accepting: [...]` names what they
will *tolerate*. A symmetric `gather: [X, Y]` was considered and not taken, for
two reasons:

- It would make the payload a bag in every case, changing what every existing
  gather's `Fn` receives for no benefit to those nodes.
- The asymmetry is true. A summary over 3,265 parcels is *about* the cards; the
  failures are an exception it must handle, not a second kind of answer. A
  declaration that says so reads better than one that pretends they are peers.

The cost, stated: `accepting` is a second list that a reader must know to look at
to understand what closes the barrier. Mitigated by `weir sys` reporting the full
accepted set rather than only `gather:`.

## 6. What stays unchanged

- **Dead groups still die.** An element resolving to something in *no* declared
  outcome still kills the group. With `accepting: [Failed_X]` declared, the
  remaining way to die is a `Failed_Many_X` from a nested gather, or an element
  whose subgraph simply ends — which residue reports.
- **`until:` composes.** A cycle-gather may also accept failures; the barrier is
  "the terminator exists" and the membership rule is unchanged by which outcomes
  count as resolved.
- **The empty collection still fires**, and an all-failures group now fires with
  an empty success collection and a full failure one — which is the honest answer
  and was previously a `Failed_Many_X`.

## 7. Explicitly out of scope

- **A tolerance threshold** (`tolerate: 0.01`). It turns a judgement into a
  number that will be wrong for somebody, and the number has no home in a
  contract — a node cannot know what fraction of failures its *caller* finds
  acceptable.
- **Implicit acceptance of `Failed_*`.** §2.
- **Reporting residue into the payload**, which the pressure test also asked for.
  It answers "what did not finish" rather than "what failed", and those are
  different questions; residue stays a property of the run.
- **Retrying the failures.** A retry node consuming `Failed_X` is already
  expressible and is a different topology, not a gather mode.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A spread of four elements where one fails, gathered with
   `accepting: [Failed_X]`, fires once with three successes and one failure.
   The motivating case.
2. **The same spread with no `accepting:` still dies**, producing
   `Failed_Many_X`. The guard against this quietly replacing the existing rule,
   and the assertion that today's behaviour is the degenerate case.
3. The failure collection is keyed by the **failed element's** index, so a caller
   can line it up against what produced it.
4. The barrier still waits: three of four elements resolved and nothing fired.
5. An all-failures group fires with an empty success collection and a full
   failure collection — not a `Failed_Many_X`.
6. Two success edges from a `oneOf` (`TownshipLookup` / `TownshipUnavailable`)
   gather together, which is §3's case and has nothing to do with failure.
7. An element resolving to an edge in *no* declared outcome still kills the
   group.
8. `accepting:` composes with `until:` on a cycle-gather.
9. `accepting:` is fingerprinted — two otherwise identical nodes accepting
   different sets are different contracts.
10. `accepting:` naming an edge nothing upstream can produce is refused at
    elaboration, like a gather with no spread above it.
11. With no `accepting:`, `Fn` receives exactly the collection it receives today.
    The back-compat assertion.
12. Every existing example still elaborates and runs, and no contract hash moves.
