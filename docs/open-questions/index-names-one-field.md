# Nothing warns about an `index` that no collection uses

Status: open, and much narrower than first filed.
Last grounded: 2026-10-01.

########################################################################
# CORRECTED 2026-10-01, hours after filing. THE CLAIM BELOW WAS WRONG. #
########################################################################

**What I claimed:** that `Revision` packing its round into `id` is *forced*, because
`index:` admits one field and a revision is identified by (manuscript, round) — and
that this made it the one instance today of string-packing that weir requires rather
than the author choosing.

**It is not forced, and the test is cheap.** `Revision` is never a collection
element, so its `index: id` is not load-bearing for keying. Removing `index: id`,
making `id` the manuscript (`"m-1"`) and leaving `round` as the round:

```
weir check  ✓
weir accept revise   ✓ accepted      (with no nextId at all)
weir test   ✓ 7 passed, 0 failed, 0 skipped
```

The last line includes the topology example that drives the three-round cycle, with
**every `Revision` sharing `id: "m-1"`**. The runtime tells instances apart by the id
it mints at the log (`LoggedInstance.id`), not by the edge's `index`. So the `-r<n>`
suffix was never load-bearing, and `revise` without it needs no `nextId`, has nothing
duplicated, and leaves nothing for an implementer to guess.

Jordan's question was the right one: *"is this a fix, or something I could have known
the answer to in one of my own examples?"* The latter. In a real project the author
knows whether `id` means the manuscript or this revision of it. The ambiguity here
came from a toy example giving `id` a composite meaning and not saying so.

## What actually survives

Two things, both smaller than the original claim.

**1. Nothing warns about a decorative `index`.** `index:` is load-bearing only for
collection keying — `many`, `gather`, and the key-agreement rule. `Revision` declares
one and is never collected, and nothing says so. That declared-but-unused key is what
invited packing a composite into it: once `id` is "the" identity, making it unique per
round looks obligatory. A `weir check` or `weir sys` line reporting *"edge X declares
`index: f` and no collection keys on X"* is cheap, decidable, and would have put the
question to the author rather than to an implementer. **This is the real residue and
is what this question is now about.**

**2. A pure node cannot mint a *random* identity** — and that is weaker than what I
first wrote here, which was "cannot mint an identity". A pure node can derive one
perfectly well: a hash, a counter read off its input. What it cannot do is invent a
fresh random one, because a UUID is nondeterminism and Principle 0 keeps that out of a
node.

**RESOLVED 2026-10-01, by somebody needing it.** `todo-list`'s `CreateTodo` takes
`NewTodo` and must produce a `Todo`, whose `id` is declared *"unique within its list"*.
Jordan removed `id` from `NewTodo`, and the node then had nothing to derive an id from.

Two things fell out, and the second is the answer:

**The mismatch is a uniqueness scope the node cannot observe.** `Todo.id` promises
list-uniqueness and `CreateTodo` never sees a list. That is the defect, and it is
independent of uuid-versus-derived: a content hash does not satisfy
"unique within its list" either, since two identical titles in one list collide. Only a
node that sees the list can honour that scope — or the caller can, by supplying the id.

**With persistence, the database mints it, and that is an effect.** Asked "what if we
wanted to save the todo to a db?", the shape becomes:

```
NewTodo      → CreateTodo [pure]   → UnsavedTodo    (no id; nothing has assigned one)
UnsavedTodo  → saveTodo   [effect] → Todo           (id from the database)
```

`SERIAL`, `uuid_generate_v4()`, `RETURNING id` — identity minting is exactly the kind
of nondeterminism weir already has a home for, and it is the effect boundary. So this
is not a weir gap at all: **effects exist for precisely this, and the example simply has
none.** `todo-list` declares five nodes and zero effects, pure end to end, which is why
the id had nowhere to come from.

The payoff is better than a workaround. `UnsavedTodo` and `Todo` become distinct edges
meaning "not yet persisted" and "persisted", and the id's presence is the type-level
record that persistence happened — weir's own "a decision becomes a type" claim,
applied to identity.

### Nobody mints it — and the host already did

Jordan's objection to "the caller supplies it": *"we wouldn't expect a **user** to mint a
todo's own id."* Right, and it splits "caller" into two things. A human types a title and
a description. A *client* — an offline-first app generating a client-side UUID — is a
perfectly ordinary source, and is outside the program either way. weir's boundary is the
program's boundary, not the human's. But neither is the best answer, because there is a
third source that costs no product decision at all.

**weir already mints one, per invocation, and already records it.** `Envelope` carries
`id: string` (types.ts:326), minted at `membrane.ts:535` and written into the trace. And
replay re-feeds recorded envelope fields rather than re-minting them — `replay.ts` does
exactly this for `identity`, `step` and `causationIds`:

> *"The replayed call is re-fed `entry.envelope.identity` … `entry.envelope.step` is
> re-fed the same way … `entry.envelope.causationIds` is re-fed for the same reason"*

So a node reading the invocation id would be **replay-deterministic by the mechanism
already in use**: the value is host-minted, durable, and fed back on replay — the same
contract that makes an effect replayable.

The mechanism to read it already exists and is an explicit extension point. `scope`
resolves `read:Identity:<field>` and its own error says *"only … resolves to anything
**today**"*; the declared-envelope spec lists *"`read:` on anything but `Identity` and
declared envelopes"* as deliberately out of scope rather than impossible. So:

```yaml
# CreateTodo.node
scope:
  - read:Invocation:id
```

would hand a pure node an identity it did not invent. **Unbuilt, and the smallest
principled answer to "who mints an id".**

### The three sources, and none is the user

| source | when it fits | status |
|---|---|---|
| the host's invocation id, via `scope` | any program, no product decision | **unbuilt**; one field on a designed hook |
| the database, via an effect | the program persists | works today; gives the `UnsavedTodo`/`Todo` split |
| the client (not the human) | offline-first, client-generated UUID | works today; a product decision |

Third time today a finding resolved to *you were holding it wrong* rather than to new
machinery, after the invented provenance and the packed `Revision.id` — though this one
leaves a real and small thing behind, which the other two did not.

########################################################################
# THE ORIGINAL ARGUMENT, PRESERVED. THE "FORCED" CLAIM IS WRONG.       #
########################################################################

## The question

`Revision` declares `index: id`, so `id` is the instance identity and has to be
unique per round. But a revision is really identified by a **pair** — which
manuscript, which round — and `index:` names a single field. So the round gets
concatenated into the identity:

```
id: "m-1-r1"   round: 1
id: "m-1-r2"   round: 2
```

The round now exists **twice**: once as a typed `uint8` with `min: 1, max: 10`, and
once inside a `utf8` as an `-r<n>` suffix that nothing declares, validates, or
relates to the field it duplicates.

## What it cost an implementer

An agent given only the sealed contract wrote everything it could decide and then
stopped:

```ts
function nextId(p: reviseInput): string {
  // TODO(jordan): decide what an id without a matching "-r<round>" suffix means.
  throw new Error("revise: nextId not implemented");
}
```

with the reasoning: *"The examples pin one case: `m-1-r1` at round 1 becomes
`m-1-r2`. Everything else is a choice, because the gate will hand this ids like `L`
and `1Q` that carry no `-r<round>` suffix at all."*

That is the right instinct applied to a slightly wrong target. There **is** a total
function, and it needs no decision about suffix-less ids:

```ts
p.id.replace(/-r\d+$/, "") + "-r" + (p.round + 1)
```

An id with no suffix simply gains one (`"L"` at round 1 becomes `"L-r2"`), the
declared example is satisfied, and `weir accept` passes. But look at what it does on
a *disagreeing* input:

```
"m-1-r9" at round 1  ->  "m-1-r2"
```

The suffix is rebuilt from `round`, not carried from the old suffix. **That is a
semantic commitment — `round` is authoritative and the suffix is derived — and
nothing in the contract states it.** The real ambiguity is not what a suffix-less id
means; it is which of the two copies of the round wins when they disagree. The
implementer has to decide that, and has nothing to decide it from.

## The answer was in the repository, where the implementer could not see it

`runtime.test.ts:2845` already contains exactly that expression, in the fixture that
drives this example's topology end to end:

```js
id: r.id.replace(/-r\d+$/, "") + "-r" + (r.round + 1)
```

So the convention exists, is relied upon, and is recorded only in a test. This is the
third thing in one day whose answer was in the repository and absent from the sealed
contract — the others being the property-path grammar (`property.ts`'s header
comment) and the `{edge, payload}` shape of a tagged result.

## Directions, none settled

- **Let `index:` name several fields.** `index: [id, round]` and the identity is the
  tuple, so nothing is packed and the duplication disappears. The largest change: the
  identity is what `many` keys a collection by and what the `index`-agreement rule
  checks, so a composite key has to serialize *somewhere* to be a collection key, and
  then the question is only whether weir does the packing instead of the author.
  Doing it in one place with a declared separator is still better than each author
  inventing one.
- **Declare the derivation.** Keep one field, and say that `id` is derived from
  `(manuscript, round)` — which needs a notion of a computed field that
  [can a closure carry a formula?](can-a-closure-carry-a-formula.md) is already
  circling.
- **Say which copy is authoritative** and leave the packing alone. Cheapest, and it
  only documents the redundancy rather than removing it.
- **Nothing.** Defensible: a string identity is what most systems have, and the
  author can pick a convention. The cost is measured above — an implementer that
  cannot infer the convention, and a correctness rule living in a test fixture.

## Related

Three instances today of **structured data packed into a `utf8`**. All three were the
author's choice; the "forced" reading above is the part that was wrong:

- geometry inside `RawParcelFeature.featureJson` (blue-ribbon) — friction #1, the
  author's choice.
- the round inside `FactFinding.claim` (manuscript-review) — the author's choice,
  fixed 2026-10-01 by declaring `round` as a field.
- the round inside `Revision.id` — also a free choice, as the correction at the top
  shows. Unpacking it costs nothing and removes `nextId` entirely.

Also related: [positional identity](positional-identity.md), which is the same
question about a node's identity rather than an edge instance's.
