# Field-level classification

Status: implemented (the query; enforcement is §4, not built).

## Motivation

`design.md` §7, the sentence zones were half of:

> Field-level classification labels (PII, financial) combine with zones to make
> leakage a static query: *no edge carrying an unredacted PII field may cross
> into a non-client zone.*

Zones shipped, so weir can now say where the network hops are. It cannot say
what is going over them, which is the half that makes the sentence a *query*
rather than a map.

## 1. The label lives on the field, and is part of the contract

`classification?: string` on `FieldDef`, beside `measure`, `format`, `relation`
and `sourceKey`.

**Fingerprinted**, on the precedent `relation` sets: `hash.ts` already includes
metadata that describes what the data *means* and excludes only cosmetics
(`description`, `unit`, `sourceKey`, `label`). A classification has a stronger
claim than `relation` does — it decides whether a topology is **legal**, so a
silent change to one could make an already-accepted program illegal with nothing
noticing.

The cost, stated rather than discovered: adding a label to a field moves that
edge's schema hash, and transitively the contract hash of every node naming it.
That is the intended behaviour of a contract change and the same cost any field
edit already carries.

## 2. The vocabulary is open, like `zone`

§7 names PII and financial. Those are **examples**, and this does not turn them
into an enum. A closed set is easy to add later and impossible to remove once
somebody's ontology depends on a label this repo did not think of — the same
reasoning zones took a day earlier, and for once the two halves of §7 agree on
something.

The cost is that nothing catches `classification: pii` against
`classification: PII`. Worth it for now; a vocabulary is a decision that wants a
real ontology behind it, not a guess.

## 3. Nested fields carry their labels

An edge's sensitivity is not only in its own scalar fields. A `Person` embedded
in an `Order` takes its labels with it, and a query reading only the top level
would pass an edge whose PII is one level down. So `classificationsOf` walks
compound and `many` fields to any depth — the same recursive shape `assertPayload`
and `fingerprint` already walk.

It carries a cycle guard those two do not. They assume edge definitions are
acyclic, which `elaborate` enforces; this runs on a *query* path over
author-supplied shapes, and the guard costs a `Set`. Without it a self-reference
throws `RangeError: Maximum call stack size exceeded` — checked rather than
assumed, after this paragraph first claimed it would *hang*, which would have
sent a reader looking for a timeout that never comes.

## 4. What ships: the query, not the policy

`weir sys` annotates each zone crossing with what it carries:

```
crossings
  Entity   extractEntities (server) -> investigate/investigateIdentity (third-party)  carries pii
```

That is §7's sentence, answerable. What it is **not** is enforcement: nothing
here rejects that crossing.

**And a limit found after shipping, by the first program to serialize anything
(2026-09-29):** a crossing is measured at the *node boundary*, while the wire
format is produced inside whichever node or handler serializes. So an edge
carrying a serialized `POLYGON((...))` string crosses reporting only the labels
on its *own* fields, and the labelled geometry edge behind the string never
crosses at all — a **false negative**, which is the one failure mode a leakage
query cannot afford. §5 below argues that an unlabelled edge crossing is the
design working, and that holds for deliberate redaction; it does not hold when
the labels were lost to *encoding*. Recorded in `open-questions.md`; not fixed
here.

**Deliberate, and the reason is that the policy has nowhere to live yet.** §7's
rule is parameterised by a label *and* a set of zones — "no **PII** into a
**non-client** zone" — and neither half is declared anywhere. A rule needs a home:
a `policy` file, an `admits:` list on a zone, or something else. Each is a real
design decision, and inventing one to make this feature feel finished would be
choosing by accident.

A candidate worth recording, not taken: **a zone declares what it admits.** The
topology already declares `zone:`, so `admits: [public]` is one more optional key
on the file that already says where the unit runs, and the rule becomes derivable
with no new file type. It also keeps the policy next to the boundary it governs.

## 5. Redaction is not modelled, and §7 already says how it would be

§7's tokenization pattern is *"a fission/join pair, not an inverse"* —
`redact: Person -> allOf[RedactedPerson, TokenMap]`, with `TokenMap` never
leaving the client zone. Nothing in this spec models "redacted": a
`RedactedPerson` is simply an edge whose fields carry no classification, and the
query then reports no PII crossing, because there is none.

That is the design working rather than a gap. The word "unredacted" in §7's rule
does not need a flag — it is the absence of a label on the edge that actually
crosses.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A field's `classification` moves its edge's schema hash, and so the contract
   hash of a node naming that edge.
2. A crossing reports what it carries, on `examples/soc-triage`: `Entity` leaves
   for the third-party zone carrying `pii`, twice.
3. A crossing of an unlabelled edge carries nothing — the `AssetContext` and
   `IdentityContext` coming back.
4. A label nested inside a compound field is found. The case a top-level-only
   walk would pass.
5. A label nested inside a `many` field is found.
6. A self-referential edge definition does not blow the stack — it *overflows*
   rather than hanging, which this list originally got wrong.
7. `classification` is accepted by the field schema and an unknown sibling key is
   still rejected — the guard against widening the schema by accident.
8. Every example still elaborates; only `soc-triage` labels anything.

## Explicitly out of scope

- **Enforcement** (§4). The query ships; the policy has nowhere to live yet, and
  a candidate is recorded rather than taken.
- **A closed label vocabulary** (§2).
- **Redaction as a modelled concept** (§5) — §7's fission/join pattern already
  expresses it with edges that exist.
- **Classification on an edge rather than a field.** Plausible for "this whole
  edge is sensitive", and it would need a rule for how the two combine. Not
  needed to answer §7's question, which is about fields.
