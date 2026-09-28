# A topology declares its beginning

Status: implemented.

## Motivation

This is `examples/recipe`'s run payload:

```json
{ "mix": { "title": "Chocolate Chip Cookies", … }, "preheatOven": { "title": "Chocolate Chip Cookies", … } }
```

The same trigger, written twice, because `runNetlist` keys origin payloads by
**node**. Both origins declare `input: Recipe`; one external event produced one
recipe; the API has no way to say so.

`design.md` §5 already blesses the opposite, and has since long before any of
this was built:

> A graph with several origin-shaped inputs doesn't trigger them independently at
> different times — there is exactly one call to the graph's outer membrane per
> external event, and every origin-shaped edge it declares needing resolves from
> that single payload at once.

"every origin-shaped edge **it declares needing**" — the topology declares what
the trigger must supply. Nothing expresses that, so the sentence has been
aspirational since it was written.

It is also the last caveat on *a topology is a node*. Yesterday every topology
gained `output` and `terminals`, and the readme, design.md and the spec all had
to say the same thing three times: a root declares its **end** like a composite
but not its **beginning**, so the claim got closer to true without becoming true.

## 1. The fork: add `input:` to roots, or delete the distinction

**Option A — roots also declare `input:`.** Smallest change. `isCompositeTopology`
stays `"input" in raw`, which now distinguishes nothing, so the elaborator needs
some *other* way to tell a root from a composite. Rejected: it keeps a
distinction while removing the thing the distinction was made of.

**Option B — every `.topology` declares `input`, `output`, `terminals`, `wiring`,
and the root/composite distinction collapses to "is it referenced".** A topology
another topology names is inlined where it is named; one nothing names is an
entry point, and its wiring is the program. Nothing is declared about *which*
kind a file is, because nothing needs to be.

**Resolved: B.** It removes a special case rather than adding a field, and the
distinction it removes is already derivable — measured across the repo, with no
ambiguity anywhere:

| topology | referenced by |
|---|---|
| `soc-triage/investigate` | 1 |
| every `main` (all six examples) | 0 |

A root was never a different kind of thing. It was a composite nobody had
referenced yet.

## 2. What the trigger means

An entry topology's `input:` declares the shape of one external event. Every
origin node resolves **its own declared input edge** from that one payload:

```yaml
# declarations/main.topology
input: Recipe
output: Cookies
terminals:
  - cool
wiring:
  mix:
    then: { bake: { then: { cool: {} } } }
  preheatOven:
    then: { bake: {} }
```

`mix` and `preheatOven` both declare `input: Recipe`, so both are fed from the
one `Recipe` the trigger supplied. Written once, which is the whole point.

For `input: allOf [A, B]` — two origins wanting different edges from one event —
the payload is a bag keyed by edge name, and each origin takes the edge it
declares. That is the same bag shape an `allOf`-input *node* receives, so no new
encoding is introduced.

## 3. Resolution belongs to the host, not to `runNetlist`

§5's sentence says *the graph's outer membrane* populates origins from the single
payload. The outer membrane is the host boundary; `runNetlist` sits below it and
receives already-resolved inputs. So the trigger is resolved **above** the
runtime:

```
resolveTrigger(entry, payload) -> Record<string, unknown>   // node name -> payload
```

`weir run --payload` calls it; `runNetlist`'s `Run.originPayloads` is unchanged.

Two things this buys beyond correct layering. It is a pure function over a
declaration and a value, so it is testable without running anything. And it
leaves every hand-built `Program` in the test suite — which declares no entry
contract at all — working exactly as before, the same way `ends` is optional for
the same reason. **Rejected alternative:** adding `Run.payload` beside
`originPayloads` would put two ways to say one thing into the runtime's own
interface, which is the shape this repo has been removing all week.

## 4. The check: the trigger must cover the origins, and vice versa

A new elaboration rule, in both directions, because each direction catches a
different mistake:

- **Every origin's declared input edge must appear in the entry's `input`.** An
  origin the trigger cannot supply can never fire, which is the same silent
  never-fires this repo already rejects for arcs (Rule A) and coverage (Rule B).
- **Every edge the entry declares must feed at least one origin.** A declared
  input nothing consumes is a promise the program does not keep — and it is how
  a renamed origin would otherwise leave the contract quietly stale.

Both are decidable from the declarations alone, which is where this belongs.

## 5. What this does *not* resolve

**Direct invocation.** open-questions.md asks whether a node should ever be
invoked directly or whether that is just a one-node topology — and notes that
collapsing it would delete two bypasses that exist only because staged instances
have no envelope. This spec does not collapse it. `invokeWithInput` still exists,
`fuzz`/`accept`/`replay` still use it, and the bypasses stay.

That is deliberate rather than deferred-by-omission: routing the acceptance gate
through a full pulse loop would change what the gate actually tests, and that
deserves its own decision rather than riding along with a declaration change.

**So "a topology is a node" becomes true of the declaration and not yet of the
machinery.** After this, an entry topology and a composite are the same shape and
the same checks — but a *node* can still be invoked in a way a topology cannot.
Stated here so the claim is not overread again.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A `.topology` declaring no `input` is rejected, naming the file. Required on
   every topology now, not just composites.
2. `resolveTrigger` feeds **both** of `recipe`'s origins from one `Recipe`
   payload, and the resulting run is identical to today's duplicated one. The
   motivating case; assert the two origin payloads are the same value.
3. `resolveTrigger` on an `allOf` entry hands each origin the edge it declares,
   and nothing else.
4. An origin whose input edge the entry does not declare is rejected at
   elaboration (§4, first direction).
5. An entry declaring an edge no origin consumes is rejected (§4, second
   direction) — the case a renamed origin produces.
6. A topology **referenced** by another is inlined and is *not* an entry, and one
   referenced by nothing **is** — asserted on `soc-triage`, which has one of each.
   The check that the collapse in §1 actually holds.
7. `weir run --payload` takes the trigger shape and exits 0 on `examples/recipe`,
   with a payload written **once**.
8. Every example still elaborates and runs after migration.

## What the build confirmed, and one thing it sharpened

**The collapse holds with no ambiguity.** `soc-triage` has one topology
referenced by another and one referenced by nothing, and deriving the entry from
that is a five-line loop. One case needed naming that §1 did not: a topology
mentioning **itself** is a cycle, not a reference that demotes it from entry —
counting it would silently leave a program with no entry at all. `inlineComposites`
rejects self-reference separately, so the guard here is one clause.

**`parseRootTopologyFile` is gone rather than kept beside its sibling.** The two
parsers differed only by `input`, so requiring `input` everywhere left one
function. `isCompositeTopology` survives as a predicate nothing branches on any
more, and the reduction is the point: a root was a composite nobody had
referenced.

**The migration reached further than §6 estimated**, because requiring `input`
touched every fixture that yesterday's `output`/`terminals` change had touched —
this time with a value that had to be *derived per fixture* (each entry's origin
node's declared input edge) rather than added uniformly. Mechanical, but not a
constant: a script derived most of them from the fixture's own node declarations
and six needed doing by hand, where the origin came from a shared constant rather
than an inline literal.

## Explicitly out of scope

- **Direct invocation and the two bypasses** (§5).
- **Multiple entry topologies.** Allowed and merged, as today; whether a program
  *should* have more than one entry is a separate question this does not open.
- **The run root carrying the trigger payload.** It deliberately does not
  (2026-09-25-system-nodes-run-root-and-noop.md), and nothing here changes that:
  origin payloads reach their nodes through resolution, not through the root.
- **`Unit` as an entry input.** No example uses it, and inventing the ergonomics
  for a trigger that carries nothing is better done when something needs it.
