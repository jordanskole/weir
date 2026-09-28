# A root topology declares its end

Status: implemented.

## Motivation

`residue` (2026-09-27-quiescence-is-not-success.md) made a *stalled* run loud: a
node left holding input nothing will deliver is now reported and `weir run`
exits non-zero. It says nothing about the other half — the run where everything
was consumed tidily, nothing is waiting, and the thing you wanted never
appeared. That was recorded as **(b)** and left open on one question: required,
or optional.

**Resolved: required.** Not on general explicit-over-implicit grounds, though
those hold, but because of what the exception costs. Every other boundary in
weir declares its contract — a `.node` declares `input`/`output`, a *composite*
`.topology` declares `input`/`output`/`terminals`, and `assertCompositeContracts`
checks the terminals actually produce the output. A **root** topology declares
nothing: `isCompositeTopology` is literally `"input" in raw`, so the root is the
one topology that is a bag of wiring.

Which is why the readme's "a topology is a node" carries a caveat saying the
root topology in its own example cannot be dropped into a larger graph. This
spec shrinks that caveat rather than adding a feature — it cannot delete it,
because a root still declares no `input` (§5).

## 1. The naive formulation is a false green, measured

The obvious design — a root declares `output:` naming its terminal edges — was
checked against all six examples before being specced, by computing which edge
types each one leaves unconsumed:

| example | unconsumed edge types |
|---|---|
| `recipe` | `Cookies` |
| `escalation` | `Resolution` |
| `soc-triage` | `AlertAssessment` |
| `person-birthday` | `Pass`, `Fail` |
| `manuscript-review` | `Accepted`, `ReviewNote` |
| `todo-list` | **none** |

Three are trivial. `person-birthday` is a genuine `oneOf` terminal and reuses
existing vocabulary exactly. The last two are the design:

**`manuscript-review` shows "everything unconsumed" is the wrong reading.**
`Accepted` is the success condition; `ReviewNote` is a *byproduct*, one per
round, genuinely useful and not what finishing means. The author has to choose
which is which, and that choosing is precisely the value of declaring.

**`todo-list` shows edge types cannot express it at all.** Its nodes are
rhombus-shaped — `AddTodoToList: allOf[TodoList, Todo] -> TodoList`,
`CompleteTodo: Todo -> Todo` — so every edge type is both an intermediate and a
terminal. `output: TodoList` would be satisfied by an **intermediate**
`TodoList` that `startList` emitted three pulses earlier. The check would pass
without the run having finished: this repo's signature bug, built into the
feature meant to prevent it.

## 2. `terminals:` is the mechanism; `output:` is the contract

The fix is the pair composites already declare, meaning the same things.

```yaml
# declarations/main.topology
output: Cookies
terminals:
  - cool
wiring:
  mix:
    then:
      bake:
        then:
          cool: {}
  preheatOven:
    then:
      bake: {}
```

Two checks, at two different times, which is what makes it precise:

**Static, at elaboration.** The declared `terminals` must collectively produce
the declared `output` — byte for byte the check `assertCompositeContracts`
already performs, extended to roots. A root naming a terminal that cannot
produce its declared output is a wiring error before anything runs.

**At the end of a run.** The log must hold an instance of the declared output
**produced by one of the declared terminals** — `envelope.node` is already
recorded on every instance, so this is a lookup rather than new machinery.

That second clause is what defeats the rhombus problem. `output: TodoList` with
`terminals: [AddTodoToList]` is satisfied only by a `TodoList` whose
`envelope.node` is `AddTodoToList`; the intermediate one from `startList` does
not count, because `startList` is not a terminal. Declaring the *node* is what
makes an instance-level question answerable at all, and it is exactly why
composites declare terminals rather than inferring them.

## 3. Terminals cannot be inferred, and `escalation` proves it

The obvious objection to requiring `terminals:` is that it looks derivable — the
leaves of the wiring. It is not, for two independent reasons, and both are in
the repo already.

**A cyclic topology has no leaf.** `escalation` is `openTicket -> triage ->
triage`: the terminal node feeds itself, so structural leaf-detection finds
nothing at all. Iteration is a first-class shape here (`design.md` §3), so this
is not an edge case to be waved at.

**A leaf is structural; a terminal is semantic.** `manuscript-review` has
`revise` self-looping and `verdict` as a leaf. Whether finishing means "a
verdict was reached on every round" or "the manuscript was accepted" is an
authoring decision with two defensible answers, and no analysis of the wiring
can pick one.

Inference would also silently change meaning when the wiring changes — add a
node downstream of `cool` and the topology's declared end quietly moves. A
declaration does not.

## 4. All three output modes are used, which is the argument for reusing them

`output:` on a root is an ordinary `OutputSpec`, not a new list type. Across the
six examples every mode is already needed:

- **single** — `recipe` (`Cookies`), `soc-triage` (`AlertAssessment`).
- **`oneOf`** — `person-birthday` (`Pass` or `Fail`). The run finished if *one*
  branch appeared, which is what `oneOf` means everywhere else.
- **`allOf`** — `todo-list` (`TodoList` *and* `Todo`, from its two terminals).
  The run finished only if *all* appeared.

**A declared terminal that never fires is not an error**, and `oneOf` is why: a
topology branching to terminal `A` or terminal `B` declares both, and exactly
one fires. The runtime check is on the *output*, never on "every terminal ran" —
the terminals' job is to make the output question answerable, not to be a
checklist. Stated because the wrong version of this rule is the easy one to
write, and it would reject `person-birthday` on its first run.

## 5. What stays open: `input:` on a root

A composite declares `input:` too, and this spec deliberately does not require
one. A root's input is the *trigger*, and the trigger has known plumbing debt:
`runNetlist` takes `originPayloads` keyed by **node** name, while a contract
would name **edges**. `design.md` §5 already blesses "one external event, every
origin-shaped edge it declares needing resolved from that single payload at
once" — so the model allows it and the shape does not yet express it. That is
the same root cause as open-questions.md's "should a node ever be invoked
directly, or is that just a one-node topology", and it should be resolved there
rather than half-answered here.

Consequence, stated rather than hidden: after this spec a root topology declares
its *end* like a composite but not its *beginning*, so "a topology is a node" is
closer to true and not yet true. The readme's caveat gets smaller, not deleted.

## 6. The cost, counted

Required means every existing root topology and test fixture gains two keys.
Measured: **6 root topologies** under `examples/`, and **~49 `.topology`
mentions** across the test fixtures. Most fixtures are three lines of wiring
that exist to test edge or node parsing, and they gain two more.

Taken deliberately. A constraint that is optional from day one never gets
pressure-tested (`design-history.md`, "Acceptance gating, generalized one layer
up" makes the same call for a different gate), and the fixtures that gain two
lines are the ones where "what is this topology for" was never written down.

The migration is mechanical and is part of the build, not follow-up work.

## Testing

Break-proofs required for each, recorded in the test's own comment along with
what the break-proof showed — including breaks that turn out **not** to redden,
since three of `gather`'s did not and saying so is what kept them honest.

1. A root topology with no `output:`/`terminals:` is rejected at elaboration,
   naming the file. The whole point of required.
2. A root whose `terminals` cannot produce its declared `output` is rejected at
   elaboration — the static half, reusing the composite check.
3. A root naming a terminal that is not a declared node is rejected, with the
   same message a composite gets.
4. **The rhombus case, which is why the spec exists.** A run that fires only
   the non-terminal producer must **not** satisfy the check, even though an
   instance of the declared output edge exists in the log. *Built*, and its
   break-proof is the one that matters: with the `envelope.node` clause dropped
   — checking only that an instance of the edge exists — the test **passes**,
   which is exactly the false green the design is arranged around. If it ever
   goes green with that clause removed, the check is decorative.
5. A `oneOf` root is satisfied by **one** branch, and a declared terminal that
   never fired is not an error (`person-birthday`).
6. An `allOf` root is satisfied only when **every** declared edge appeared
   (`todo-list`).
7. A run that finishes reports success; a run that consumes everything and
   produces no declared output is an error naming what was expected. Both
   through `weir run`, asserting the exit code. *Built.*
8. This check and `residue` are independent: a run can stall *and* miss its
   output, and both are reported. Neither message replaces the other. *Built*,
   and the CLI's stall fixture turned out to be **both** at once — it never
   reaches its declared end *and* strands a node — so that test now asserts both
   messages rather than one. The sibling case is also covered: a run that
   *reaches* its end while stranding a side branch reports residue and no unmet
   end.
9. Every example still elaborates and runs after the migration — the guard
   against a constraint strict enough to reject the corpus it was written for.
   *Built*, asserting each example declares exactly one end with a non-empty
   terminal list, so a migration that dropped a contract would be caught rather
   than silently skipping the check.

## What the build added that this spec did not anticipate

Two terminal names an author legitimately writes turn out not to exist by the
time the check runs, because the elaborator replaced them. Both are now expanded
rather than rejected, in `expandTerminals`:

- **A terminal naming a composite.** The natural thing to write when a topology
  ends on one — and after inlining, `pair` is gone, replaced by `pair/toLeft`
  and `pair/toRight` (or `pair#1/…` and `pair#2/…` when referenced twice).
  Expanding keeps the declaration in the author's vocabulary: they name the unit
  they wired, not its insides. Deliberately done *after* inlining, since only
  then is the instance count known.
- **A terminal naming an `anyOf` node**, which desugars into `<name>__<edge>`
  shadows the author never wrote — the same expansion `resolveNodeName` already
  applies to the wiring. Exactly one shadow fires, so such an end behaves like a
  `oneOf`; requiring every shadow to have produced would be the "every terminal
  must fire" rule §4 rejects, arriving by a different route.

Unresolvable names pass through unchanged rather than expanding to nothing, so a
typo is reported by the contract check instead of silently emptying the terminal
list and making the end vacuous.

## Explicitly out of scope

- **`input:` on a root topology** (§5), pending the `originPayloads` question.
- **Inferring terminals from the wiring** (§3), which cannot work for cyclic
  topologies and cannot choose between defensible readings for the rest.
- **Requiring a terminal to actually fire** (§4). The check is on the output.
- **Cardinality.** "At least one instance of the declared output" — not exactly
  one, not one per anything. A run producing three `ReviewNote`s and one
  `Accepted` is finished; counting is a different question and probably a
  property, not a topology declaration.
- **Static liveness** — "can this topology ever reach its declared end" is
  answerable for some shapes and is its own piece of work, unchanged by this.
