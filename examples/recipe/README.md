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
Recipe { title, servings,    |                                    v
  temperature,                                              bake  (allOf [Dough, Oven] -> BakedCookies)
  ingredients: many(Ingredient) }                                 |
  | gatherIngredients (Recipe -> Recipe, origin)                  v
                              |                              cool (BakedCookies -> Cookies { done: true })
                              +-- preheatOven  (Recipe -> Oven) ---+
```

`gatherIngredients` fans out to two independent branches — `mix` and `preheatOven` — that both read
straight off the gathered `Recipe` and run without waiting on each other. `bake` declares
`input: allOf: [Dough, Oven]`: the readiness check `todo-list`'s `AddTodoToList` also uses, except
here both branches actually get produced, so it resolves for real. `.topology` needs no special join
syntax for this — `bake` just appears again under `preheatOven`'s own `then:`, the same node fed by
two different parents.

`gatherIngredients` is `Recipe -> Recipe` — a real step (confirm everything's on hand before you
start) that happens not to transform the payload, the same shape `todo-list`'s `CreateTodo` already
established as legitimate.

Every stage past that gets its own edge name — `Dough`, `Oven`, then `BakedCookies`, then `Cookies`
— rather than reusing `Recipe` throughout. `title`/`servings` carry forward unchanged through the
`mix` branch; only the name changes. That's deliberate: it's the same dish, but a different
real-world state, and `types.ts`'s own header comment names exactly this case — "two edges with
identical shape but distinct meaning... a name exists so that refinement... can be expressed when a
decision needs to survive into the next node's type." `ingredients` is dropped after `mix` on
purpose — once the dough is mixed, the individual ingredients aren't distinguishable or useful
anymore.

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

Like `todo-list`'s `CreateTodo` and `person-birthday`'s `birthday`, `gatherIngredients` takes
`Recipe` as its input directly and is the topology's own origin — no separate `Unit`-input,
closure-literal node. That's the pattern both existing fixtures actually implement on disk; the
`Unit`/closure-origin convention in `examples/person-birthday/netlist.json` is a first draft that
fixture never adopted (see that file's own README).

## The real recipe

A classic chocolate chip cookie recipe — 24 cookies, baked at 375°F. The full ingredient list
(butter, granulated sugar, brown sugar, eggs, vanilla extract, flour, baking soda, salt, chocolate
chips) is real; the `.node` files' `examples:` trim that down to three (`Butter`, `Flour`,
`Chocolate Chips`) to keep the YAML readable, the same trimming judgment `todo-list`'s single-item
collections already make.
