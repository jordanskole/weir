# Should a minted identity be a field *kind*, like a literal?

Status: open — a concrete proposal, not yet weighed against its costs.
Last grounded: 2026-10-01 — raised by `todo-list`'s `CreateTodo` having nowhere to get
an id from.

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

## What it costs, honestly

**`assertPayload` is side-agnostic today, and this is the first rule that is not.** One
function validates both a node's input and its output. A literal is symmetric — the
producer must return it and the consumer sees it — but a minted field is not: the producer
must **not** supply it and the consumer **must** have it. `Todo` is produced by
`CreateTodo` and consumed by `CompleteTodo` and `AddTodoToList`, so the same edge needs
different rules on each side. That is the real implementation cost, and it is structural
rather than fiddly.

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
