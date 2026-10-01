# `gather … accepting`: partition, beside sequence

Status: implemented.

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
  settled:
    - Failed_ParcelCard
output: CorridorSummary
```

`settled:` borrows the one distinction a reader is most likely to already hold
precisely: `Promise.all` is `sequence` and fails on the first rejection;
`Promise.allSettled` waits for every outcome. That is exactly the pair being
added here. The cost, taken deliberately: it is vocabulary from one host
language, and an OCaml implementation comes after v1 — but the concept is not
JavaScript's, only the spelling is.

**Today's behaviour is the degenerate case, not a parallel mechanism.** With no
`settled:`, the declared set is `{ParcelCard}`, a `Failed_ParcelCard` falls
outside it, and the group dies exactly as it does now. That the existing rule
falls out of the new one unchanged is the main reason to believe this shape is
right.

## 2. Tolerance is named in the contract, or it does not happen

An author must write the edge they will tolerate. There is no threshold, no
`settled: true`, and no implicit acceptance of `Failed_*`.

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
  settled:
    - TownshipUnavailable
```

A failure-specific `tolerating:` would not have covered this, and the two cases
would have grown separate machinery for one question. `settled:` reads correctly
for both, because "this element has settled" is true of a legitimate absence and
of a failure alike — which is the property the name was chosen for.

## 4. The node still receives one collection — the barrier is not the payload

**Corrected 2026-10-01, and it changed the design rather than the wording.** A
first version of this spec had the gather receive a bag of successes *and*
failures:

```js
{ ParcelCard: {…}, Failed_ParcelCard: {…} }   // WRONG
```

That puts the branch **inside the node**, and weir's position is that a node
takes a single input and branching lives in the topology. The objection came from
outside this spec and is correct.

**The barrier and the collection are two different things.** `settled:` widens
*what closes the barrier*; it never widens what the node receives. So `Fn` gets
exactly the collection it gets today — a map keyed by each element's `index`,
holding instances of the **one** edge the node gathers.

The failures are handled by a **separate node**, in the topology:

```yaml
# summarizeCorridor.node — sees only the cards
input:
  gather: ParcelCard
  settled: [Failed_ParcelCard]

# reportFailures.node — sees only the failures
input:
  gather: Failed_ParcelCard
  settled: [ParcelCard]
```

Both close on the same barrier; each receives one edge. The partition is real and
it is drawn in the wiring, where a reader can see it — see
[the diagram](2026-10-01-gather-barrier.html).

Three consequences worth stating:

- **No payload shape changes.** There is no conditional bag, and no existing
  gather's `Fn` sees anything different. The back-compat question disappears
  rather than being managed.
- **`settled:` is symmetric in use and asymmetric in reading.** Each node names
  what it gathers first and what else settles second, so the two declarations
  above are mirror images. Neither node is privileged.
- **A failure needs no `index`.** It was only required because the earlier design
  handed failures to the node as a keyed collection. `reportFailures` gathers
  `Failed_ParcelCard` as its *own* edge, so the ordinary gather keying applies
  with nothing special-cased.

## 5. One keyword, not a second input kind

`partition:` as its own input kind was the leading candidate until §4's
correction, and the correction is what rules it out: the node does not partition.
The topology does. A key named for an operation the node no longer performs would
be worse than an awkward one that describes the barrier accurately.

It would also need a second key to say which of the partitioned edges *this* node
receives — `partition: [A, B]` plus `take: A` — which is two keys to express what
`gather: A` already says.

Rejected for the same reason: `or:`, because `or` is already a property-language
operator and echoes `oneOf`, making three meanings for one word in one
declaration language.

## 6. What stays unchanged

- **Dead groups still die.** An element resolving to something in *no* declared
  outcome still kills the group. With `settled: [Failed_X]` declared, the
  remaining way to die is a `Failed_Many_X` from a nested gather, or an element
  whose subgraph simply ends — which residue reports.
- **`until:` composes.** A cycle-gather may also accept failures; the barrier is
  "the terminator exists" and the membership rule is unchanged by which outcomes
  count as resolved.
- **The empty collection still fires**, and an all-failures group now fires with
  an **empty** collection rather than a `Failed_Many_X` — the honest answer, and
  the one a sibling `reportFailures` node makes useful by gathering the failures
  on its own wire.

## 7. Explicitly out of scope

- **A tolerance threshold** (`settled: 0.01`). It turns a judgement into a
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
   `settled: [Failed_X]`, fires once with the three successes. The motivating
   case.
2. **The same spread with no `settled:` still dies**, producing
   `Failed_Many_X`. The guard against this quietly replacing the existing rule,
   and the assertion that today's behaviour is the degenerate case.
3. **The node receives one collection, not a bag.** `Fn` gets exactly what it
   gets with no `settled:` declared — the §4 correction, and the assertion that
   the barrier is not the payload.
4. The barrier still waits: three of four elements resolved and nothing fired.
5. An all-failures group fires with an **empty** collection — not a
   `Failed_Many_X`. The honest answer, and previously impossible.
6. Two success edges from a `oneOf` (`TownshipLookup` / `TownshipUnavailable`)
   gather together, which is §3's case and has nothing to do with failure.
7. An element resolving to an edge in *no* declared outcome still kills the
   group.
8. `settled:` composes with `until:` on a cycle-gather.
9. `settled:` is fingerprinted — two otherwise identical nodes settling on
   different sets are different contracts.
10. `settled:` naming an edge nothing upstream can produce is refused at
    elaboration, like a gather with no spread above it.
11. **Two gather nodes over the same spread both fire**, one per edge, each
    receiving only its own — the topology-level partition, which is the shape
    this is actually for.
12. Every existing example still elaborates and runs, and no contract hash moves.

## What the build found

**`until` was never fingerprinted.** Shipped 2026-09-29 and caught adding
`settled` here: `fingerprintInput` returned `{ kind, edge }` for a gather and
nothing else, so two gathers differing only in their barrier hashed identically
and an accepted implementation stayed valid across a changed one. TypeScript did
not catch it either, because an excess property arriving through a conditional
spread is not checked. Both are fingerprinted now, and the fingerprint *type*
carries them so the next addition cannot repeat it.

**The two-node partition this spec draws could not be declared.** `reportFailures:
gather Failed_Parcel` was rejected at elaboration — *"`Failed_Parcel` declares no
index"* — because a synthesized failure edge's fields are `{ input, reason }` and
it has no index of its own. The design in §4 was unbuildable as written.

Fixed by keying a gathered failure collection on the **failed element's** index,
read through `input`, in a shared `gatherKey` helper. That is better than the
alternative of keying by instance id, and for a reason worth keeping: it makes
`reportFailures`' collection use the *same keys* as `summarizeCorridor`'s, so a
reader can line the two up and ask which parcels failed. Keying by id would
answer "how many" and nothing else.

**The index rule lived in three places.** Elaboration, the runtime's keying, and
the membrane's collection assertion each enforced it separately, and the membrane
was still rejecting what the other two had learned to accept — so the group formed
correctly and the firing died afterwards, which is a confusing place to debug
from. All three now ask `gatherKey`.

**One correction is unreachable and is labelled as such.** Excluding the
*gathered* edge from the failure set — so a node gathering `Failed_X` is not
killed by its own members — reddens nothing. `isDead` is gated on
`resolved < size`, a complete group is never dead whatever failed inside it, and
the pulse loop assesses every element of a spread in one pulse, so the state that
would distinguish them does not arise. Two fixtures were written trying to make
it redden before concluding that. Kept because it is correct; labelled at the
site and in the test file so it does not read as covered.
