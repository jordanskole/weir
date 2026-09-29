# Drift is data, and a fork is how you act on it

Status: draft.

## Motivation

`design.md` §1 and `readme.md` both say an edge is **"the complete description
of what crosses a wire."** It is not. `assertPayload` iterates
`Object.entries(edge.fields)` — the *declared* fields — checks each against the
payload, and returns `record` unchanged. It never looks at the payload's own
keys.

So an edge is a **lower bound**: declared fields must be present and well-typed,
and anything else rides along into the durable log. Demonstrated rather than
argued, with a handler returning one field the edge never declared:

```
http: async () => ({ pin: "x", acres: 3.5, surprise: "new upstream field" })
→ ✓ quiescence
→ Parcel -> {"pin":"x","acres":3.5,"surprise":"new upstream field"}
```

The boundary itself is sound and was built deliberately — `runtime.ts` wraps
every effect handler so its result is asserted against the declared output edge,
*"because a handler is host code and no more trusted than a drafted `Fn`"*, and
a wrong type becomes `Failed_X` with the reason. The hole is only in what
"asserted" covers.

Three consequences, worst first:

1. **Classification is unsound.** `weir sys` reports what a crossing carries by
   reading declared fields' `classification`. An undeclared field carries no
   label because it is not declared, so an owner name arriving as a new field
   crosses into a third-party zone and the query reports the crossing as
   carrying nothing. The pressure-test called this *"the untyped hop swallowed
   it"* about an opaque blob (2026-09-28-what-a-real-program-found.md §6); it is
   equally true of every typed edge.
2. **The log accumulates undeclared data** — append-only, replayable, and
   potentially holding fields nobody declared.
3. **Neither hash sees it**, so `verify`'s drift refusal is blind to it.

And it misses the single most common real-world API change: a server that
*starts* sending a field.

## 1. The safety rule, stated

**Nothing arriving from outside is trusted, and the declared schema is the whole
of what is trusted about it.** This is not new policy — it is what the effect
wrapper already implements and what §1's sentence already claims. This spec
closes the gap between the two.

The reference point is a validating client: you would not take an HTTP response
into your domain without checking it against the shape you expect. weir's
position is stronger than most such clients, because the checked value is then
written to a durable log that other things read later — an unchecked field is not
a local inconvenience, it is a permanent record.

## 2. Undeclared fields are stripped, not rejected

`assertPayload` collects keys present in the payload and absent from
`edge.fields`, and **returns a payload containing only the declared fields**.

**Rejecting was considered and is the wrong default.** Three reasons, and the
third is the one that decides it:

- An additive upstream change is the benign, common case. Rejecting halts a
  pipeline on every one of them, which for an ETL over five independently
  operated county servers is brittle enough that the rule would be turned off.
- Stripping hides nothing that matters. A *renamed* field leaves its declared
  name missing, which is already a violation and already caught; so is a
  retyped one, and so is a typo in the `.edge` file. Strip only ever silences
  the additive case.
- The additive case is **not silenced**, because of §3. Rejecting buys
  visibility that recording already provides, at the cost of availability.

A per-edge strict mode is a later, additive decision (§7), and deliberately not
taken now: it is easy to add once something wants it and impossible to remove.

**One implementation hazard worth naming in the spec rather than discovering.**
`assertPayload` returns the payload, and today's callers use it inconsistently —
`assertOutput` is `void` and discards it. A strip that the caller throws away is
a silent no-op that every test would still pass. The stripped value must be the
one that reaches the log, and that is the thing to break-proof.

## 3. Drift is recorded on the envelope

`Envelope` gains `undeclared?: string[]` — the key names, sorted, present only
when non-empty.

**Names on the envelope, values in the trace.** The envelope carries only what an
agent needs to *trigger* on, which keeps the sensitive half in one place rather
than two.

**The trace only holds the raw result on the path where it passed, and that is
not good enough.** Checked rather than assumed, after this section first claimed
the values "survive without being copied anywhere new". On a *failed* assertion
the trace's `result` is the `Failed_X` payload — `{input, reason}` — and the
shape the handler actually returned is recorded **nowhere**:

```
handler returns { pin: "x", acres: "three point five", surprise: "..." }
trace result:   { input: {pin:"x"}, reason: "Parcel: acres should be number, got string." }
```

So this spec must also **record the raw result in the trace when an assertion
fails**, not only when it passes. Without it §5's fork has nothing to re-validate
for exactly the run that most needs re-validating, and the discovery loop below
is impossible.

Not fingerprinted, and not part of `schemaHash`: this is an observation about one
invocation, not a declaration.

**A limitation to state plainly:** `Host.trace` is optional (`runtime.ts:354`),
so a program run without one records that drift happened and loses what the
values were. The names still reach the envelope. `weir run` always opens a
trace, so this affects programmatic hosts only.

## 4. A fork is a new run, because the log does not change

Widening an edge in response to drift raises the obvious question of what
happens to the run that already recorded the old shape. **Nothing happens to
it.** The log is append-only and the recorded run is the historical record of
what actually crossed the wire.

Re-validated data therefore lands in a **new run**, not in new entries on the old
one. The reason is mechanical rather than philosophical: a run is the unit of
consumption, and appending a second `Parcel` to the same `correlationId` puts
two instances of one logical token on the same wire, where every downstream node
sees both as unconsumed candidates and fires twice. *"A run is one traversal"* —
a second traversal is a second run.

The forked run's `Run` root gains `forkedFrom` (the parent `correlationId`).
Cross-run ancestry is then explicit and queryable without disturbing
`log.instances(edge, correlationId)`, which every reader in the system uses.

## 5. What a fork executes, and what it pins

`weir fork <parent-run>` re-executes a recorded run under the **current**
declarations, into a new `correlationId`. The execution rule is a hybrid, and
it is the heart of this spec:

- **Effect nodes return the parent's recorded result**, read from the trace —
  including a result that *failed* assertion in the parent, which is the whole
  point of recording it (§3).
  `replay.ts:65` already does exactly this for the same reason: an effect is
  where nondeterminism entered, and letting it re-enter would make the fork
  incomparable to its parent. It is also the only option that works — a drifted
  server will not return the same bytes twice, which is why the trace exists.
- **Pure nodes re-execute.** That is the entire point: to see what the widened
  data does downstream.

Two properties fall out, and both are what make the agent loop viable:

**A fork is deterministic.** Every nondeterministic input is pinned to the
parent's recording, so forking one run against a hundred candidate schemas
varies only the declarations. The comparison is sound.

**A fork needs no effect handlers, and no credentials.** `--effects` is not a
parameter. Every effect comes from the trace, so a production run can be forked
on a laptop with no access to the systems it touched.

## 5b. Discovery, not just drift — the larger claim this buys

With §3's failed-path recording, the loop covers a case the spec did not
originally reach. **Additive drift** (a server starts sending a field) passes
assertion, so `undeclared` is populated and the values are in the trace.
**Discovery** — not knowing the field names yet — and **truncation** — a
shapefile-derived `c_Parcel_I` where `Parcel_ID` was expected — both make a
*declared* field missing, so assertion **fails** and `undeclared` is never
reached.

Those are the cases a real integration starts in. The sibling project's field
names were *"discovered by querying live servers and corrected months later"*;
you cannot declare a schema you do not have. Recording the raw result on the
failing path turns that into: **run once against the live server, then fork
offline against candidate schemas until one validates.** No credentials, no
second request, and the server's actual bytes as the fixture.

The `Failed_X` reason should also name the observed keys, so the first failure
is itself the beginning of the schema rather than only a complaint about it.

## 6. The fork point is derived, and the blocked nodes are the answer

Nothing declares where a fork diverges. It is the first node whose contract hash
differs from the parent's recorded `contractHash`, and reporting it is most of
the command's value.

**Widening an edge moves the contract hash of every node naming it**, and an
implementation is resolved *by* contract hash — so immediately after a widening,
those nodes have no accepted implementation. A fork must therefore report which
nodes are blocked awaiting acceptance rather than failing opaquely. That is the
acceptance gate working: a changed contract is a contract nothing has been
accepted against.

This also fixes an inconsistency found while probing: `replay`'s hash-drift
refusal (`replay.ts:68`) is **unreachable for effect nodes**, because the effect
short-circuit at line 65 returns first. A replay of an effect under a changed
contract currently succeeds silently. Fork does not inherit that — a changed
contract is its subject rather than its hazard — but `replay` should refuse
consistently, and the two commands' opposite stances on drift are precisely why
they are two commands:

| | question | a changed contract is |
|---|---|---|
| `verify` / `replay` | does the pinned implementation still produce this? | a reason to refuse |
| `fork` | does the current declaration accept what we recorded? | the whole point |

## 6b. The example this makes possible

`examples/flaky-source` shows a handler returning the **wrong type for a field
that was declared**. It deliberately does not show one returning a field nobody
declared, because until this spec that case is silently accepted and there is
nothing to demonstrate.

Closing that gap when this ships matters for a precise reason. The first outside
reader's misdiagnosis was not *"declaring it won't help"* — it was *"I can't
declare this."* An example of a wrong type cures the first and leaves the second
untouched, which is exactly what that reader said when shown the fix: it would
have stopped the misreading, not the design error underneath it. The example
that reaches the second is a handler returning an undeclared field, the drift
record that results, and a fork against the widened edge.

## 7. Explicitly out of scope

- **Mutating the log.** Rejected outright (§4); re-validated data forks.
- **Per-edge strict mode** that rejects undeclared fields instead of stripping
  (§2). Additive later, and nothing needs it yet.
- **An agent that proposes the widening.** This spec makes the loop mechanically
  possible — detect, widen, fork, compare — and builds none of the judgement.
- **Forking a fork.** It follows from §4 (a fork is a run like any other) and is
  not specially built or tested.
- **Cross-run queries in `sys`.** `forkedFrom` is recorded; nothing reads it yet.
- **Reconciling a fork back into its parent.** There is no merge, and it is not
  obvious there should be one.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. An undeclared field does not reach the log: the logged payload has exactly the
   declared keys. **The break-proof that matters** is the §2 hazard — a strip
   whose return value the caller discards, which must redden this.
2. A declared field that is missing or mistyped still fails, as it does today —
   the guard against "strip" quietly becoming "accept anything".
3. The undeclared key names reach `envelope.undeclared`, sorted; absent entirely
   when nothing drifted.
4. The raw values, including the undeclared ones, still reach the trace.
5. `undeclared` moves neither `contractHash` nor `schemaHash`.
6. Widening an edge moves `schemaHash`, and a fork of the pre-widening run
   produces the widened payload from the recorded raw data.
7. A fork runs with **no** effect handlers supplied, and its effect nodes'
   outputs equal the parent's recorded results.
8. A fork's pure nodes genuinely re-execute — a downstream node's output differs
   from the parent's when the widened field changes its result.
9. The forked run's `Run` root cites `forkedFrom`, and the parent run's instances
   are untouched — same count, same ids, same payloads, after the fork.
10. A fork reports nodes blocked for want of an accepted implementation under the
    new contract, rather than failing opaquely.
11. A fork of a run with no declaration changes reproduces it — the degenerate
    case, and the one that shows fork and `verify` are the same machinery.
12. `replay` refuses a contract-drifted **effect** node, closing the
    unreachable-refusal hole in §6.
13. **The raw result reaches the trace when the assertion *fails*** — the case
    §3 originally got wrong, and the one §5b depends on. The break-proof is the
    before-state: the trace records `{input, reason}` and the observed shape is
    unrecoverable.
14. A run that failed assertion can be forked against a widened declaration and
    succeed — schema discovery end to end, with no handler supplied.
15. The `Failed_X` reason names the observed keys.
16. Every existing example still elaborates and runs, and no logged payload
    anywhere gains or loses a field.
