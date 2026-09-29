# Instantiation: one declaration, N contracts

Status: implemented.

## Motivation

The pressure-test project's top blocker: five county parcel adapters share one
interface and differ in a field name, an area formula and a PIN separator. At
five that is tolerable. The stated ambition is statewide — **83 counties** — and
83 edges plus 83 nodes differing in `{fieldName, areaFormula, pinSeparator}` is
*configuration wearing an ontology costume*.

**The question is not undesigned, and the open-questions entry claiming so was
wrong.** Three things already exist:

1. `design-history.md`, "Generics: elaboration monomorphizes", settles the
   mechanism: a **node declaration** and a **node** are different things;
   templates live in source, instances live in the netlist, elaboration is the
   boundary, and a type variable must never appear in an emitted netlist.
   Variance is invariant, deliberately. Bounded polymorphism is allowed.
2. `NodeDecl.closure` exists — *"parameters baked in at elaboration time"* —
   parsed by the elaborator, carried on the declaration, **fingerprinted** into
   the contract hash, and exported in the sealed contract.
3. That entry's own second stated cost is this exact failure: *"if the elaborator
   isn't pleasant to use, the forty declarations get hand-written instead."*

What is missing is the build. And the corpus already demonstrates the cost at
N=1.

## 1. `closure` is inert, and the one example that uses it hand-writes the answer

`examples/person-birthday/src/nodes/expect_Person_age_42.node` declares:

```yaml
closure:
  expected:
    Person:
      age: 42
```

Three facts about that file, all verified:

- **The monomorphization is hand-written in the filename.** `expect` + `Person` +
  `age` + `42`. `expect_Person_age_41` would be a second file differing in one
  number — 83 counties at N=2.
- **The closure is correctly hashed.** Two parameterizations are two contracts,
  which is exactly the property instantiation needs, and it already holds.
- **Nothing reads it.** `closure` appears in `elaborate.ts` (parsed),
  `hash.ts` (fingerprinted) and `contract.ts` (exported). It appears nowhere in
  `membrane.ts`, `invoke.ts`, `runtime.ts` or `accept.ts`. An implementation of
  this node has no way to see `42` and would have to hardcode it.

So the parameter reaches the *drafting agent*, through the sealed contract, and
never reaches the *function*. A declared parameter no implementation can read is
documentation with a hash attached.

## 2. Delivery: the closure is closed over, which is what the name says

An implementation whose node declares a `closure` exports a function **of** that
closure:

```ts
// implementations/expect_Person_age_42/<hash>.ts
export default (closure) => (person) =>
  person.age === closure.expected.Person.age ? { edge: "Pass", payload: {} } : { edge: "Fail", payload: {} };
```

`resolveImplementationAt` applies it once, at resolution, and the runtime holds
an ordinary `Fn`. Nodes with no closure export a plain `Fn` exactly as today, and
which shape is expected is known from the declaration, so nothing is ambiguous.

**Chosen over the two alternatives, for reasons worth recording:**

- *A second argument (`fn(payload, closure, env)`).* Rejected because it makes
  every implementation's signature carry a parameter most of them do not have,
  and because it invites reading the closure per-invocation when it is static
  by construction.
- *A field on the envelope.* Rejected as a category error. An envelope is
  **per-invocation** runtime data; a closure is **per-contract** static data that
  is already in the hash. Putting static data on the invocation record would
  make the trace record it once per firing and make replay look as though it
  were re-supplying something that could have differed.

Partial application also has the property the other two lack: **the accepted
artifact is the un-applied function**, so one body can serve N contracts (§3)
while each contract keeps its own hash, its own path, and its own gate run.

## 3. Instantiation: the table is the configuration, made reviewable

A `.node` may declare `for:` — a list of instantiations. Each row elaborates to
one concrete node, named by the template plus the row's key:

```yaml
# normalizeParcel.node
for:
  - key: Osceola
    edge: OsceolaRaw
    pinField: PIN
    areaField: Shape__Area
  - key: Iosco
    edge: IoscoRaw
    pinField: TaxID
    areaField: Shape_Area
input: $edge
output: NormalizedParcel
closure:
  pinField: $pinField
  areaField: $areaField
```

elaborating to `normalizeParcel_Osceola` and `normalizeParcel_Iosco`, each a real
node in the netlist with its own contract hash.

**The table is the point, not the syntax.** 83 near-identical files assert that
83 different things exist; one table with 83 rows asserts that one thing exists
in 83 configurations, and *that is the true claim*. It is also reviewable as a
unit — a reviewer reads one file and sees every county, where today they would
diff 83.

Three constraints this inherits rather than invents:

- **No type variable survives.** Each row produces a concrete node naming
  concrete edges, per the monomorphization rule. `$edge` is substituted at
  elaboration and is gone.
- **Instantiations are invariant.** `normalizeParcel_Osceola` is not assignable
  where `normalizeParcel_Iosco` is expected. They are different nodes.
- **The closure is in the hash**, so *editing* a row's parameters moves that
  contract. Two rows are two contracts for a simpler reason, corrected during
  the build: each is named `<template>_<key>` and the **name** is fingerprinted.
  The closure's contribution is to the edit case, which is the same argument
  `scope` was fingerprinted for — an accepted implementation must not stay valid
  against a parameter it was never checked against.

## 4. Examples are per-row, because a template's examples cannot be honest

A template's examples would have to be written against `$pinField`, which is not
a value. So **`examples` moves into the row**:

```yaml
for:
  - key: Osceola
    edge: OsceolaRaw
    pinField: PIN
    examples:
      - given: { OsceolaRaw: { PIN: "10 003 013 20" } }
        expect: { NormalizedParcel: { pin: "10-003-013-20" } }
```

This is not a concession — it is the feature working. Each instantiation is a
contract, the gate runs per contract, and **a row with no examples is a contract
with no examples**, which `schema.ts` already refuses. So the table cannot be used
to smuggle 83 unexercised nodes into a program: every row pays the same price
every hand-written node pays today.

`properties`, by contrast, stay on the template. A property is written over
`input`/`output` paths, and the paths that differ per row are precisely the ones
the closure names — so a property that holds for one row holds for all of them,
or it was never a property of *this* node.

## 5. What this does not do

- **It does not unify the bodies.** Five counties' arithmetic genuinely differs —
  one needs a Web Mercator latitude correction, another divides by a constant
  because its acreage field truncates to integer. A closure carries a *value*,
  not a formula, so those stay distinct implementations, and the pressure test's
  own report says so: *"what does not dissolve is the arithmetic."* This spec
  makes the 60 counties that differ only in field names cost one row each; it
  does nothing for the 23 that differ in kind, which is correct — **they are not
  varying only in configuration, and the point of the feature is to stop
  pretending otherwise.**
- **It does not make the edges one edge.** `OsceolaRaw` and `IoscoRaw` remain
  distinct declared edges, because they genuinely have different fields. Edge
  templating is a separate question and this spec does not open it.
- **It does not introduce generics.** No `T`, no bound, no unifier. `for:` is a
  generate block, and the type-variable form designed in
  `design-history.md` remains unbuilt and is not blocked by this.

## 6. Explicitly out of scope

- **Edge instantiation** (`for:` on a `.edge`). Wanted by the same use case and a
  larger question, since an edge template's fields would vary in *name*, which is
  the one thing structural hashing is most sensitive to.
- **Bounded polymorphism** and the type-variable form generally.
- **A row drawn from an external file.** The table being *in the declaration* is
  what makes it reviewable and hashable; sourcing it from a CSV would put the
  contract outside the acceptance gate.
- **Generating the rows.** 83 rows are written or scripted by the author. weir
  elaborates what is declared.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A node declaring a `closure` resolves to an implementation that receives it,
   and `examples/person-birthday`'s `expect_Person_age_42` passes the gate with
   a body that reads `closure.expected.Person.age` rather than hardcoding 42.
2. A node with no closure resolves a plain `Fn`, unchanged.
3. Two rows of one template produce two nodes with **different contract hashes**.
   Separately, and this is the one that needed care: a node whose **closure
   changes with its name held constant** gets a new hash. The first draft of
   this conflated them and passed with `closure` removed from the fingerprint
   entirely, because it was measuring the names.
4. One implementation body accepted for two rows lives at two paths and passes
   the gate twice, once per row's examples.
5. `$var` substitution reaches `input`, `output` and `closure`, and an
   unsubstituted `$var` surviving into an elaborated node is an error rather than
   a literal.
6. A row with no `examples` is refused, for the same reason a node with none is.
7. A property on the template is checked against every row.
8. The netlist names instances, never the template — the monomorphization rule's
   "no type variable in the emitted netlist", applied to `for:`.
9. A duplicate `key` in the table is refused, since it would collide two nodes.
10. Every existing example still elaborates, and no contract hash moves — nothing
    in the corpus declares `for:`, and `closure`'s hashing is unchanged.

## What the build found

**`closure` was schema-constrained to two shapes, and `design.md`'s description
of it was not.** `nodeSchema` admitted only `{ expected }` or `{ literal }` —
`expect`'s value and an origin's literal, the two uses that happened to exist —
while `design.md` called the field "parameters baked in at elaboration time". A
`for:` row's parameters are neither, so the schema had to widen to an open
object.

The cost, taken rather than hidden: schema-level typo detection on `expected` is
gone, because a schema cannot both admit arbitrary objects and constrain
specific shapes. One check survives generalization and was kept — the two
conventions are mutually exclusive, so a closure declaring **both** is
contradictory whatever else it carries.

An attempt to keep both with a three-branch `oneOf` is worth recording because
it failed in an instructive way: `{ expected }` matched the named branch *and*
the open one, which `oneOf` forbids, so `examples/person-birthday` was rejected
outright — and reported as a missing `literal`.

**A test that measured the wrong thing.** See Testing #3. The draft asserted two
rows differing only in closure get different hashes; it passed with `closure`
removed from the fingerprint, because the row names differ and names are
fingerprinted. Replaced with the edit case, which is what the property is
actually about.
