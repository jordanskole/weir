# Property assertions: `∀ p . birthday(p).age == p.age + 1`, made real

Status: implemented.

## Motivation

`design.md` §6 lists three things a node declaration carries beyond its types — examples, **properties**, and prose — and shows properties exactly once, as notation: `∀ p . birthday(p).age == p.age + 1`. It never specifies a mechanism, and nothing in `types.ts` has ever represented one. Three consecutive specs have now deferred it: the sealed-contract spec, the generator/fuzz-harness spec, and the acceptance-pipeline spec, whose own Motivation says out loud that its bar is "narrower than §6 describes, deliberately: examples by exact equality plus a structural check, not §6's `∀ p . ...` property assertions, which still have no representation in `types.ts`." This spec closes that.

**Why properties rather than more examples.** §6's argument is that "a single example underdetermines the function and the implementing agent can see the test." That is not theoretical here — it is demonstrated by a fixture already in the test suite. `accept.test.ts`'s `EXAMPLE_ONLY` candidate passes its declared example by hardcoding the example:

```js
export default function birthday(payload) {
  if (payload.age === 41) return { age: 42 };
  return { nope: true };
}
```

It satisfies every example the node declares and is still wrong for every other input. A universally-quantified property cannot be gamed that way, because the generator chooses the inputs, not the implementer. Examples remain valuable for the reason §6 gives — they are legible, the thing a reviewer reads to see intent — but they cannot carry the correctness claim alone.

**What this changes about acceptance.** Today `acceptImplementation` means "structurally well-formed, and consistent with whatever examples someone bothered to write." With properties it means "and satisfies every invariant the contract asserts, across generated inputs." That is the difference between a gate that catches crashes and a gate that catches wrong answers.

## Design

### 1. `PropertyExpr` — a data-expression AST

A property is data, not host code. `design.md` §10 is explicit that a `.node` file declares the contract only and that `Fn` is host code "which a data format can't and shouldn't hold"; a property that was a TypeScript predicate could never be authored in YAML, could never survive the still-open "which host language elaborates" question (current lean: OCaml), and could not be hashed structurally.

```ts
// spikes/ts-prototype/src/property.ts

export type PropertyExpr =
  | { lit: string | number | boolean | null }
  | { get: string }
  | { eq: [PropertyExpr, PropertyExpr] }
  | { ne: [PropertyExpr, PropertyExpr] }
  | { lt: [PropertyExpr, PropertyExpr] }
  | { lte: [PropertyExpr, PropertyExpr] }
  | { gt: [PropertyExpr, PropertyExpr] }
  | { gte: [PropertyExpr, PropertyExpr] }
  | { add: [PropertyExpr, PropertyExpr] }
  | { sub: [PropertyExpr, PropertyExpr] }
  | { and: PropertyExpr[] }
  | { or: PropertyExpr[] }
  | { not: PropertyExpr }
  | { implies: [PropertyExpr, PropertyExpr] };
```

**Key-as-discriminant**, not a separate `kind:` field — the same idiom `OutputSpec`'s `oneOf`/`allOf`/`many` and `ManyEdgeDef`'s `many` already use, and which `design-history.md` recorded as a deliberate convention ("the presence of the key itself acting as the discriminant rather than a separate `kind:` field").

**`implies` is a primitive, not sugar** for `or(not(a), b)`. These are human-authored contracts read by humans and by an implementing agent; `implies` is how the intent actually reads, and desugaring it would make every conditional property harder to author and harder to review. It also gives the evaluator a place to hang antecedent tracking later (see Out of scope).

Deliberately absent: multiplication/division (no case yet), string operations (no case yet), quantifiers over collections (a `many` output's entries — real, but a significantly larger language). The set above is the smallest that expresses §6's own example plus the conditional properties an `oneOf` node needs.

### 2. `PropertyDecl`, and where properties live

```ts
export interface PropertyDecl {
  name: string;
  description: string;
  expr: PropertyExpr;
}
```

`description` is required, matching this codebase's standing rule that every declared thing explains itself — `FieldDef` and `EdgeDef` both require `label` and `description`, and a property whose intent is only legible by reading its AST is exactly the kind of thing that rule exists to prevent.

`NodeDef`/`NodeDecl` gain `properties?: PropertyDecl[]`. Optional, unlike `examples` (which `schema.ts` requires and which `acceptImplementation` now refuses to accept a node without): a node whose contract is fully pinned by its examples is a legitimate thing to declare, and forcing a ceremonial property onto every node would produce exactly the box-ticking `examples`-as-required is already at risk of.

### 3. Path resolution

`{ get: "..." }` resolves a dotted path against a scope of `{ input, output }`:

| Node shape | Path | Resolves to |
|---|---|---|
| `single` input | `input.age` | the payload's `age` |
| `allOf` input | `input.Person.age` | the bag's `Person` entry, then its `age` |
| `single` output | `output.age` | the result payload's `age` |
| `oneOf` output | `output.edge` | the tag name that fired |
| `oneOf` output | `output.payload.age` | the tagged payload's `age` |
| `many` output | `output` | the whole keyed collection (comparisons on it are a declaration bug; see below) |

This is a direct reading of `InputPayload`/`OutputResult`'s own runtime shapes, not a new addressing scheme.

**A path that does not resolve is a declaration bug and throws**, naming the property and the path — it does not evaluate to `undefined` and quietly make a comparison false. This matches the convention `fuzzNode` and `assertPayload` already share: a defect in the declaration is thrown loudly and immediately, never collected as though it were a data-level finding. Likewise a top-level expression that evaluates to a non-boolean, or a comparison between incomparable types, throws as a declaration bug rather than counting as a violation.

### 4. Evaluation

```ts
export function evaluateProperty(expr: PropertyExpr, scope: { input: unknown; output: unknown }): unknown;
```

A plain recursive evaluator over the union, dispatching on which key is present. No host-language escape hatch, no `eval`, nothing that can reach outside the scope object it is handed.

### 5. Properties participate in the contract hash

`hashNode` gains `properties` in its fingerprint. A property is a claim the contract makes, so strengthening one means any previously-accepted implementation was accepted without ever being checked against it — and §10's whole premise is that acceptance means checked. Changing a property therefore changes the hash, which means the node needs a fresh implementation accepted against the stronger contract, exactly as any other contract change does. §10 already treats implementations as disposable, so this is the intended cost rather than a regrettable one.

**Order must not matter.** Two nodes declaring the same properties in a different order assert the same contract, so they must hash identically — otherwise reordering a list in a `.node` file would spuriously invalidate a perfectly good implementation. Properties are therefore **sorted by `name` before fingerprinting**, which requires `name` to be unique within a node: a duplicate name is a declaration bug and throws, both because it makes the sort ambiguous and because `name` is what a property violation is reported under (§7), where two properties sharing one name would make the report unreadable. Within a property, the expression is fingerprinted structurally, exactly as `hash.ts` already handles nested field shapes.

**`examples` remains excluded from the hash**, as it is today. This leaves a real, now-explicit hole: adding an example to a node does not invalidate its accepted implementation, so an implementation can sit marked accepted while an example it was never checked against sits in its contract. Recorded in `open-questions.md` by this spec rather than silently tolerated; not closed here, because changing it shifts every existing accepted hash and deserves its own decision.

### 6. The vacuity guard

Properties are evaluated only for generated cases that produced a **real output**. A case that resolved to `Failed<In>` is skipped — it neither satisfies nor violates the property, because the property asserts something about an output that does not exist.

That alone would be the third instance of a bug this project has now shipped twice: a check whose pass predicate accepts `Failed<In>` is vacuous unless something else constrains the result. (`design-history.md` records both prior instances — a generator's invalid output counted as a passing fuzz case, and a candidate that fails on every input reported `accepted: true`.) So:

**If a node declares any properties, at least one generated case must produce a real output, or the run fails.** A node that fails on every input can no longer score a clean sweep of zero violations. The two concerns stay separate and legible: what the property says, versus whether it was ever actually exercised.

> **Superseded 2026-09-24 — the guard is no longer conditioned on properties.** Scoping it to property-declaring nodes made it the third instance of the very bug this section names, which is worth stating plainly since the paragraph above predicted the shape and then walked into it. The reasoning missed that properties were not what made the run vacuous; they were only what made it *visible*. Zero real outputs means the structural bar passed every case through `isAcceptableResult`'s `looksLikeFailed` branch, so it examined nothing — properties or no properties. A candidate special-casing its declared examples and throwing on every other input passed its examples exactly, drew zero structural failures, declared no properties, and was accepted and written to disk. The rule is now **zero real outputs fails the run, unconditionally**. The trade-off taken knowingly: a legitimate node whose valid domain is too narrow for the generator to hit is now refused rather than accepted unchecked.

### 7. `fuzzNode` and `FuzzReport`

`fuzzNode` grows property checking rather than a parallel module generating its own cases: one seeded generation pass, one set of invocations, one report. The guard in §6 needs a count of real outputs, which the same loop computes naturally.

```ts
export interface FuzzReport {
  total: number;
  passed: number;
  failures: { input: unknown; error: string }[];
  realOutputs: number;
  propertyFailures: { property: string; input: unknown; output: unknown }[];
}
```

A property failure records which property, the input that broke it, and the output produced. The generator is seeded, so a reported counterexample is reproducible by re-running with the same seed — which is why no counterexample-minimisation is needed for the failure to be actionable.

### 8. `acceptImplementation`

A candidate is accepted only if — in addition to today's conditions — `propertyFailures` is empty and the §6 guard is satisfied. A property violation is an ordinary `checks-failed` rejection carrying the report, not a new result arm: from the caller's perspective it is the same category of thing as an example failure, which the existing `checks-failed` arm already carries.

### 9. `exportContract`

`SealedContract` gains `properties`. An isolated agent writing an implementation must be told what it has to satisfy; a property it cannot see is a requirement it can only meet by luck. This is the same reasoning that already puts `examples`, `closure` and `scope` in the sealed contract.

Note this is not the "agent can see the test" problem examples have. An agent that sees a property still cannot hardcode its way past it, because the property is quantified over inputs the generator chooses.

### 10. YAML authoring

Properties are authorable in a `.node` file, since that is where §6 says a node's contract lives — and since properties are now in the contract hash, leaving YAML out would mean a YAML-authored node could never have one.

**`schema.ts`'s `nodeSchema()`** gains a `properties` array whose items are `{ name, description, expr }`, with `expr` validated against a **recursive expression schema** defined once under `$defs` and referenced by `$ref` — the standard JSON Schema mechanism for a self-referential grammar, and within what `redhat.vscode-yaml` supports. Each operator is a single-key object with the right arity: binary operators take a two-element array, `and`/`or` take an array, `not` takes one expression, `lit` a scalar, `get` a string.

**`elaborate.ts`'s `parseNodeFile`** destructures `properties` alongside the `examples`/`closure` it already handles, and passes it through onto the `NodeDecl`. The same treatment `examples` already gets — no cross-file resolution needed, since a property references only paths within its own node's input and output.

A worked example, the one §6 has always used:

```yaml
properties:
  - name: increments age by one
    description: A birthday advances the person's age by exactly one year.
    expr:
      eq:
        - get: output.age
        - add:
            - get: input.age
            - lit: 1
```

## Explicitly out of scope

- **Antecedent vacuity.** An implication is automatically true whenever its antecedent — the "if" half of `implies(A, B)` — is false. So the §6 guard catches "the node never produced output," but not "this property's condition was never triggered": a property like `implies(input.age > 200, output.age == 200)` passes every generated case in which `age` happens to be 200 or less, having never once tested the behavior it exists to pin down. Zero violations, zero actual coverage. Catching it means tracking, per property, how often the antecedent actually evaluated true, and guarding on that too — which is part of why `implies` is a primitive here (§1) rather than desugared into `or`/`not`, where the structure needed to track it would be lost. Real, worth doing, and deliberately not half-built in this spec.
- **Counterexample minimisation (shrinking).** Already parked by the generator spec; a seeded generator makes a raw counterexample reproducible, which is enough to act on.
- **Multi-invocation properties** — idempotence (`Fn(Fn(x)) == Fn(x)`), commutativity, and anything else quantified over more than one invocation. The scope is `{input, output}` of a single call.
- **Quantifiers over collections** — asserting something of every entry in a `many` output. A real gap, and the most likely first extension, but it needs binding forms the current language has none of.
- **Properties referencing the envelope** (`env`), or identity, or anything outside `{input, output}`.
- **Topology-level properties.** `design-history.md` notes that "a property test at a subgraph's boundary is already a topology test," which makes topology validation a downstream consumer of this mechanism. Genuinely promising, entirely separate work.
- **Closing the `examples`-not-in-hash hole.** Named in §5 and recorded in `open-questions.md`; deserves its own decision.
- **Raising the vacuity guard's threshold above one.** §6's guard only distinguishes zero real outputs from at least one — a candidate that produces a real output for exactly one generated case and `Failed<In>` for the rest still scores a clean sweep. `FuzzReport.realOutputs` is exposed precisely so a caller wanting a harder bar can gate on it without a change here; no fixed fraction is built into `accept.ts` itself, since any fraction would reject a legitimately selective node.

## Testing

- `evaluateProperty` against each operator, including nested expressions and `implies`' truth table.
- Path resolution for each shape in §3's table: `single`/`allOf` input, `single`/`oneOf` output, tag access.
- A path that does not resolve throws, naming the property and path; a non-boolean top-level expression throws.
- `hashNode` changes when a property is added, changed, or removed, and is stable across reorderings that do not change meaning.
- `fuzzNode` reports a property violation with the counterexample input and output; a node whose properties all hold reports none.
- The vacuity guard: a node declaring properties whose implementation returns `Failed<In>` for every generated case fails, rather than reporting zero violations.
- `acceptImplementation` rejects a candidate that violates a property, with the report carried in the `checks-failed` arm, and persists nothing.
- The `EXAMPLE_ONLY`-shaped candidate — one that passes its declared example by hardcoding it — is **rejected** once the node declares the property its example was standing in for. This is the spec's motivating case and should be an explicit test.
- `exportContract` carries `properties` when declared and omits the key when not.
- `nodeSchema()` accepts a valid nested property expression and rejects a malformed one (wrong arity, unknown operator, `expr` missing).
- `parseNodeFile` round-trips a YAML-declared property into a `NodeDecl`, including the §10 worked example.
