# A real recipe: chocolate chip cookies, start to finish

The third worked example, alongside [`person-birthday`](../person-birthday/) and
[`todo-list`](../todo-list/) — declarations only (`.field`/`.edge`/`.node`/`.topology`), no `Fn`
implementations, same as both of those.

Where the other two lean on their vocabulary to illustrate a specific mechanic (`person-birthday`'s
`oneOf`/`expect`, `todo-list`'s `allOf`/`many`-as-a-field), this one is just a real recipe run
through a real kitchen, happy path only — including the one piece of real-world concurrency every
recipe like this has: the oven preheats while you mix the dough, and baking can't start until both
are done.

## The pipeline

```
                    +-- mix          (Recipe -> Dough) --+
                    |                                    v
one Recipe event ---+                              bake  (allOf [Dough, Oven] -> BakedCookies)
                    |                                    |
                    +-- preheatOven  (Recipe -> Oven) ---+
                                                         v
                                                   cool  (BakedCookies -> Cookies { done: true })
```

`mix` and `preheatOven` are **two origins**, not one origin fanning out. One external event — one call
to the graph's outer membrane — populates every origin-shaped edge the graph declares needing at once
(`design.md` §5), so both read the same `Recipe` payload and run without waiting on each other. `bake`
declares `input: allOf: [Dough, Oven]`: the readiness check resolves once both branches have produced.
`.topology` needs no special join syntax — `bake` just appears again under `preheatOven`'s own `then:`,
the same node fed by two different parents.

This shape was unbuildable until the run root landed (`docs/superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md`).
An origin node's output used to carry `causationIds: []` — nothing produced it — so two origins shared
no ancestor, `bake`'s join could form no lineage group, and the node silently never fired. This example
therefore used to open with `gatherIngredients: Recipe -> Recipe`, an identity node whose only job was
to mint the one `Recipe` instance both branches could descend from. It looked like dead weight and was
load-bearing. The run root supplies that ancestor for every run now, so the workaround is gone and the
two branches are origins in their own right.

Every stage past that gets its own edge name — `Dough`, `Oven`, then `BakedCookies`, then `Cookies`
— rather than reusing `Recipe` throughout. That's deliberate: it's the same dish, but a different
real-world state, and `types.ts`'s own header comment names exactly this case — "two edges with
identical shape but distinct meaning... a name exists so that refinement... can be expressed when a
decision needs to survive into the next node's type." `ingredients` is dropped after `mix` on
purpose — once the dough is mixed, the individual ingredients aren't distinguishable or useful
anymore.

`Dough → BakedCookies → Cookies` is a real spread chain, not three hand-typed edges that happen to
agree (`docs/superpowers/specs/2026-09-09-edge-spread.md`). `Dough.edge` declares `title`/`servings`
once; `BakedCookies.edge` carries them forward with `fields: { "...Dough":, done: {type: bool, ...} }`
— `...Dough:` (the empty-value spread key) copies `Dough`'s fields in whole, and `done` is added as a
new, real, mutable bool nothing upstream had. `Cookies.edge` spreads `BakedCookies` the same way and
pins `done` to `true` (`fields: { "...BakedCookies":, done: true }`) — this stage is finished, by
definition, so `done` stops being a bool a node could set incorrectly and becomes a `literal` field:
`cool.node`'s output is asserted against `done: true` exactly, never a `false` that slipped through.
`title`/`servings` never get retyped or re-declared past `Dough` — spread is what makes "carries
forward unchanged" actually mean *the same field definition*, not two definitions that happen to
match today and could silently drift apart later.

`ingredients: many(Ingredient)` on `Recipe` is the one place this example uses `many` — not chosen to
demonstrate the mechanic, it's just the honest way to model a recipe's ingredient list, the same as
`todo-list`'s `TodoList.tasks`. `Ingredient` declares `index: name` so it's usable inside `many` at
all (`elaborate.ts`'s `requireIndex`) — which also means a `many` collection's keys must be the exact
value of that index field (here, the ingredient's own `name`), not an arbitrary label. Getting that
wrong (an early draft of this example keyed ingredients by an id-shaped slug instead) fails loudly:
`assertPayload` rejects it with a mismatched-key error, caught here by the end-to-end runtime test
below rather than by anything in `elaborate()` itself — `.node` `examples:` blocks aren't
schema-validated at load time, only real runtime payloads are.

## Origin shape

Like `todo-list`'s `CreateTodo` and `person-birthday`'s `birthday`, `mix` and `preheatOven` take
`Recipe` as their input directly and are the topology's own origins — no separate `Unit`-input,
closure-literal node. What is new here is that there are *two* of them: the run root is what makes
several origins in one run joinable downstream. That's the pattern both existing fixtures actually implement on disk; the
`Unit`/closure-origin convention in `examples/person-birthday/netlist.json` is a first draft that
fixture never adopted (see that file's own README).

## The real recipe

A classic chocolate chip cookie recipe — 24 cookies, baked at 375°F. The full ingredient list
(butter, granulated sugar, brown sugar, eggs, vanilla extract, flour, baking soda, salt, chocolate
chips) is real; the `.node` files' `examples:` trim that down to three (`Butter`, `Flour`,
`Chocolate Chips`) to keep the YAML readable, the same trimming judgment `todo-list`'s single-item
collections already make.
