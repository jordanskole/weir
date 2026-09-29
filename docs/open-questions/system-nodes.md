# "System nodes": nodes whose contract determines their implementation

Status: resolved (2026-09-26, all three built).
Last grounded: 2026-09-29.

## The question

Raised after three documented gaps turned out to want the same missing thing.
The defining property, which is what made it a category rather than a wish list:
**if a node's contract admits exactly one sensible function, there is nothing
for an agent to draft and nothing for the gate to accept** — no `fn`, no
implementation file, no examples, no properties, no acceptance run. An author
node is the opposite by construction: if two reasonable implementations exist,
it is not a system node.

The motivating evidence was that an identity-shaped node immediately after the
origin was the only way to build a fan-in. `examples/recipe`'s
`gatherIngredients: Recipe → Recipe` looked like dead weight and was
load-bearing: an origin's output carries `causationIds: []`, so without it
`bake`'s join had no common ancestor to group on. Not "a rare topology breaks"
but "every fan-in pays for it with a workaround node".

## What resolved it

[spread](../superpowers/specs/2026-09-26-spread-materializes-elements.md), and
[the run root and `noop`](../superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md).
Built in the originally-argued order rather than the revised one, because
`spread` turned out to be the prerequisite for the other two being testable
against a real fan-out. All three confirm the defining property: none has an
implementation file, declared examples, or property assertions.

Two things the build settled that the entry framed as risks:

- **`noop` is synthesized on reference, not unconditionally**, unlike `Failed_X`.
  An edge table is cheap and a node table is not — generating `noop_X` for every
  declared edge put 2N unused nodes in every program. A consequence worth
  knowing: `noop_Failed_X` is available if a failure branch needs terminating,
  while `noop_noop_X` is unreachable, since no edge is named `noop_X`.
- **The `any`-in-a-type-system risk has not materialized and is also not
  disproved.** No example inserts a `noop` to silence the wiring check. Nothing
  prevents it either — the check still reports what it reports, and a `noop`
  still satisfies it. Worth re-reading if an example ever reaches for one.

## The category turned out wider than this drew it

A fourth member arrived that the entry did not anticipate, with the *opposite*
property: an **effect** node is also framework-resolved rather than drafted, but
where a system node's contract determines its *behaviour*, an effect's contract
determines *who performs it*. Both skip the acceptance gate because there is
nothing to accept.

So the real line is not "contract implies implementation" but **"implementation
comes from somewhere other than an agent"** — wider, and more useful.
