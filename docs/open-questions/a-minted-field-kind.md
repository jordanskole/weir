# Should a minted identity be a field *kind*, like a literal?

Status: **resolved (2026-10-01 — built)**. `id: { minted: uuid }`.
Last grounded: 2026-10-01.

## The proposal

Jordan: *"I think this is where `uuid` (or just 'id') becomes a special field type."*

The sharper form is a **field kind**, not a scalar type, and the precedent is already in
`types.ts`:

> *"A field pinned to a single boolean constant, **never caller-suppliable** … **A
> distinct field kind, not a `bool` with a value attached**: no `nullable`, no
> `validations`, both meaningless on a fixed constant."*

That is `LiteralFieldDef`, enforced by `assertPayload` at `membrane.ts:241`. A minted id
is the same shape with one difference: the value is **minted** rather than **pinned**.
The discriminant pattern is already there — `"many" in value` / `"fields" in value` /
`"literal" in value` — so a fourth joins it.

As a scalar type it would be worse, by the literal's own argument: `type: uuid` would
carry `nullable` and `validations`, both meaningless, and it would be *suppliable* — an
`fn` could return any string and the schema would accept it, which defeats the point.

## Why this beats reading the envelope through `scope`

The [other route](index-names-one-field.md) is `scope: read:Invocation:id`. The field kind
is better for one reason that outweighs the rest: **the declaration marks which fields are
nondeterministic, so replay knows mechanically which to re-feed.**

With `scope`, replay needs a per-node judgement about which reads to replay and which to
re-execute. With a field kind it is a property of the edge:

- replay re-feeds exactly the minted fields,
- `weir fork` mints fresh for exactly the minted fields, because a fork is a new run,
- `weir verify` has nothing to flag, because the nondeterminism is **declared**.

That is the trick weir already pulls with effects. Nondeterminism is fine when it is
declared and recorded; a minted field is a tiny effect with no handler.

## Three things it fixes that it was not aimed at

1. **The generator can produce it.** A `pattern` field makes `generateStringValue` throw
   (*"generating strings that satisfy an arbitrary regex isn't supported"*), which is why
   the uuid format cannot be declared today and why `confirmCitations` could not declare
   its round format either. A uuid is trivially generable from the seeded rng, so this
   closes a generator gap instead of opening one.
2. **It answers the index-uniqueness finding** from the same day: a minted field is unique
   by construction, so `index: <minted field>` needs no hand-maintenance — which is
   exactly what `weir sys`'s new `index, unchecked` line warns about.
3. **It removes the `Revision.id` packing.** A minted id is unique per instance without
   encoding the round into a string, so the composite never has to be packed.

## BUILT

```yaml
# Thing.edge
fields:
  id:
    minted: uuid
    label: ID
    description: Minted by the host, never by the implementation
```

The `fn` returns its output **without** the field; the membrane fills it before anything
asserts; `assertPayload` then treats it as an ordinary required string on both sides. So
the predicted cost below — `assertPayload` needing to become side-aware — **did not
materialise**, because minting happens between `fn` and the assertion rather than inside
it. That was the one structural worry and it dissolved.

Verified end to end on a real program:

```
weir accept   ✓ accepted makeThing            (fn returns { name }, no id)
weir run      ✓ quiescence
  recorded    {"name": "a widget", "id": "8c88a474-a51d-40e5-982c-b2d844c3d0c9"}
weir verify   ✓ 1 invocation(s) replayed identically
```

and the break-proof that matters, with the re-feed removed from `replay.ts`:

```
weir verify   ✗ 1 of 1 invocation(s) did not replay identically
  recorded  {"name":"a widget","id":"8c88a474-…"}
  replayed  {"name":"a widget","id":"2d0b513c-…"}
```

### The rules, and where each lives

| rule | where |
|---|---|
| the `fn` may not supply it — refused, not overwritten | `fillMinted`, membrane |
| required and non-empty once filled, symmetric on both sides | `assertPayload` |
| replay re-feeds the recorded value | `replay.ts`, from `mintedFrom` |
| `fork` mints fresh — a new run must not reuse the parent's ids | by omission; it passes no map |
| an example may not supply it, and `accept` compares without it | `elaborate`, `withoutMinted` |
| a minted field may not be a **collection key** | `requireIndex` |
| the strategy is fingerprinted; the prose is not | `hash.ts` |
| generated from the **seed**, never `crypto.randomUUID` | `generate.ts` |
| the fn's output schema omits it — `Thing.omit({ "id": true })` | `emit-zod.ts` |

The collection-key rule is the one that is circular rather than stylistic: the
key-agreement rule needs each entry under its own index value, the implementation builds
the collection, and a minted value is assigned after it returns. A minted `index` on an
edge nothing collects stays legal, and is the *best* use of one — unique by construction,
nothing to maintain by hand, which is what `weir sys`'s `index, unchecked` line is about.

### What the build found

**A false green I nearly shipped on.** The first end-to-end check reported
`weir verify  ✓ replayed identically` — and so did the break with the re-feed removed.
The break not reddening is what exposed it: my `--payload` was the wrong shape, the run
had failed, nothing was minted, and `verify` was comparing two identical `Failed`
records. The uuids I had grepped out of the log were envelope instance ids, not the
field. Fixed the payload, and then the break reddens properly.

**A test of mine proved less than its name.** The first "replay re-feeds" test called
`membrane` directly with the recorded map, so removing `minted:` from `replay.ts`
reddened nothing. Rewritten to go through `replayInvocation` against a real run. Seventh
test this day whose break-proof showed it measuring less than it claimed — and the second
time today that a non-reddening break-proof caught something a passing test hid.

**The generated JSON Schema artifacts are a carry-through site.** `schemas/*.json` are
checked in and a test compares them to their generator's current output, so adding a
field kind to `schema.ts` reddened it until `npm run generate:schemas` ran. That test
earned its keep.

## Three corrections within the hour, all from real use

Jordan put it into `todo-list` immediately, and it found three places where the rules I
shipped were wrong. All three are the same mistake: **a rule derived from the creation
case, applied to cases that are not creations.**

**1. The collection-key rule was too broad.** It lived in `requireIndex`, which has three
callers, and only one is a conflict. A `many` **field** (`TodoList.tasks: { many: Todo }`)
is assembled from instances that **already carry** their minted ids — the membrane filled
them upstream — so the node can key by them. A `gather` input likewise receives logged
instances. Only a `many` **output** is circular: the node produces N entries in one return
and must key each by its own index, but a minted value is assigned after it returns. Moved
to `refuseMintedKey`, called from the `many`-output site alone.

**2. The example rule was too broad, twice.** It forbade a minted field in `given` as well
as `expect` — but on the way *in* the instance has been through a membrane and carries its
id, so an example's `given` **must** supply it. And then it still forbade `expect` on a
transform, where the output carries the input's value and the author should name it. Now:
only an `expect` whose minted field is *not* carried from an input.

**3. Minting on every output was simply wrong.** `CompleteTodo: Todo -> Todo` would have
given the completed todo a **new** id, silently changing its identity. Worse than the bug
the rule prevented.

The fix needs no new declaration: **mint iff no input edge declares the same minted field;
otherwise carry that input's value.** It covers all three shapes in `todo-list` —
`CreateTodo: TodoInput -> Todo` mints, `CompleteTodo: Todo -> Todo` and
`EditTodo: allOf[Todo, TodoInput] -> Todo` carry. Carrying rather than relaxing to "mint
if absent" keeps the guarantee: the membrane copies, the `fn` still never supplies it.

One consequence worth stating: `assertPayload` requires a minted field, which is right at
runtime because `fillMinted` has always run by then. It is wrong for an *authored* example,
where a creation omits it, so the examples gate stands in a placeholder for an absent one
before asserting. That is the one place the authored and runtime views of an edge genuinely
differ.

## What it costs, honestly

~~**`assertPayload` is side-agnostic today, and this is the first rule that is not.**~~
**Predicted and avoided.** The worry was that one function validates both input and
output, and a minted field is asymmetric where a literal is not. Minting *between* `fn`
and the assertion dissolves it: by the time anything asserts, the host has filled the
field, so it is an ordinary required field on both sides, and the single asymmetric rule
("an `fn` may not supply this") lives in `fillMinted` rather than in the validator.

**The implementer's return type changes.** If the membrane mints on output, the `fn`
returns the output *without* the minted field — `Omit<Todo, "id">` in effect. The emitted
zod and the scaffold stub both have to say so, or an implementer writes the field and is
told it may not.

**Minting on the way out only.** An input-side minted field has no meaning, so the kind is
output-only — which the declaration does not currently have a way to express, since an
edge does not know which side it is on.

## Alternatives not yet weighed against it

- `scope: read:Invocation:correlationId` — free today, already re-fed on replay, and
  unique per invocation **for an origin node** only. The cheapest thing that works for
  `todo-list` specifically.
- The database mints it, via an effect. Works today with no new machinery, and gives the
  `UnsavedTodo` → `Todo` type split for free. Rejected as the *general* answer on Jordan's
  argument that a database should not be required for a weir app at all.
