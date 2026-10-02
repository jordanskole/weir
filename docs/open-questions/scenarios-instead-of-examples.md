# Should weir emit scenarios to answer, rather than ask for examples?

Status: open — a direction, with one measurement that changes its shape.
Last grounded: 2026-10-01.

## The idea

Jordan, after `EditTodo`:

> *"Ideally the agent doesn't ask you to write more examples, it gives you scenarios and
> you answer the question."*
>
> 1. *"what should happen in null, null?" a: "Failed", b: "Nothing"*
> 2. *"what should happen in (null, "Get 1% milk from the store")?"*

So instead of
[a report of unpinned cases](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md),
weir would emit a **question per unpinned state** with candidate answers, and each answer
*becomes* the example. The author never writes YAML; they answer multiple choice.

## The measurement that changes its shape

Enumerating states does not work. `todo-list`'s nullable input fields, against its declared
examples:

```
AddTodoToList   3 nullable →   8 states, 1 covered,  7 open
AnalyzeList     1 nullable →   2 states, 1 covered,  1 open
CompleteTodo    2 nullable →   4 states, 1 covered,  3 open
CreateTodo      2 nullable →   4 states, 1 covered,  3 open
CreateTodoList  1 nullable →   2 states, 1 covered,  1 open
EditTodo        4 nullable →  16 states, 2 covered, 14 open
StartList       2 nullable →   4 states, 1 covered,  3 open
```

**14 open states on one node.** Nobody answers fourteen questions, and most of the answers
would be the same — a questionnaire that long is worse than the one well-phrased note the
agent actually left.

## Why the two questions above are better than a sample of fourteen

They are not a sample. They are a **discriminating set**, and that is the whole trick.

The candidate *rules* for a nullable transform are few. For `EditTodo`:

```
patch per-field  (edit.x ?? todo.x)   {"title":"Buy milk and eggs",…}   {"title":"Buy milk and eggs",…}
replace per-field (edit.x)            {"title":null,"description":null} {"title":null,"description":"Get 1…
decline if any null                   "Failed"                          "Failed"
decline if all null                   "Failed"                          {"title":"Buy milk and eggs",…}

4 rules -> 4 distinct answer pairs
```

Jordan's two states separate all four. So the question count scales with the **rule space**,
not the state space — two questions pin all sixteen states, because the rule they select
determines the rest.

That reframes the feature. It is not "ask about each unpinned state"; it is **pick the
smallest set of states that distinguishes the candidate rules**, which is experiment design
rather than enumeration.

## What weir already has, and what is missing

Have:

- `unpinnedCases` (sys.ts) — which *fields* are unpinned, reported in `weir sys` and in
  each scaffold's `generated-inputs.md`.
- `generateInputCases` — produces the states, deterministically from a seed.
- examples as declarations — already the answer format, and an answer maps to one
  mechanically: the state is the `given`, the chosen answer is the `expect`.

Missing:

1. **States rather than fields.** `unpinnedCases` reports `TodoInput.title = null`
   individually; a scenario is a combination.
2. **A candidate rule set.** This is the hard part and the only genuinely unsolved one.
3. **Choosing the discriminating states** once the rules exist — mechanical: evaluate each
   rule on each candidate state, keep the states that split the rules.

## The hard part, honestly

**Where do the candidate rules come from?** For the common shape — a transform with
nullable inputs — they are derivable: per-field `??`, per-field replace, decline on any
null, decline on all null. That covers `EditTodo` exactly. But it is a hand-written
catalogue for one shape, and a node doing something else gets nothing from it.

Three ways that could go, none settled:

- **A catalogue per shape.** Honest about being heuristic, immediately useful, and it grows
  one entry at a time as shapes recur. The risk is a list nobody maintains, which is this
  repo's most frequent defect.
- **Ask the implementer for the rules.** An agent reading the contract can usually *name*
  the candidate readings — the one that got stuck did exactly that, unprompted and
  correctly. weir would then only have to pick the discriminating states, which it can do.
  This inverts the division: the agent proposes, weir discriminates, the author chooses.
- **Derive them from the output schema.** A transform's candidate outputs are bounded by
  what the output edge can hold, so for a two-field patch the space really is small. Whether
  that generalises past the shapes already seen is unknown.

The second looks best, because it puts the part that needs judgement where there is
judgement, and the part that needs enumeration where there is a generator.

## Where it would live

weir emits the question set and consumes the answers; the interaction is Jordan's hosted platform's — *"this is where it's going to get
really good with kleisli… we will be able to create structure for each stage."* The weir
side is a file in and a file out, which is also what makes it testable.

## Related

- [the deterministic scaffold](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md)
  reports unpinned cases today, which is the prose version of this.
- [property coverage over output fields](property-coverage-over-output-fields.md) — the same
  question about properties rather than examples, and it has the same "what is a check
  worth" problem underneath.
