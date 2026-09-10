# Sealed contract export, and black-box implementation metadata

Status: approved design, not yet implemented.

## Motivation

Two related, formalizable pieces surfaced discussing where weir is headed — a form/agent-assisted authoring surface where humans design nodes/edges (the ontology) and a **completely separate, isolated agent** writes each node's `Fn` body, seeing nothing but that node's own sealed contract.

**Why isolation, not just "an agent writes it":** `design-history.md`'s "The pivot's authorship line, corrected" already revised *"the human doesn't write node bodies"* from a structural claim to an unenforced stance — nothing actually stopped ontology-reasoning from leaking into implementation-reasoning, because both lived in one continuous context. Genuinely isolating the implementing agent (fresh context, no session history, no visibility into *why* the ontology was shaped this way) turns that into an enforced property, and gives it a real test: if an isolated agent, given only the contract, can produce a correct implementation, that's evidence the contract was actually complete. If it can't, that's a signal about the *declaration*, not the agent — a sharper failure mode than "this function is too complex," because it points at the spec instead of the code. This is also the direct category-theory reading of weir's own existing "implementations are disposable, regenerated not patched" design (`design.md` §10): a morphism is defined by its domain, codomain, and extensional behavior, never its internals — two implementations satisfying the same contract *are* the same morphism, so nothing is lost regenerating one from scratch.

**Why metadata, and why not a live gate:** inspired by a LinkedIn post (Hugo Matinho, "CRAP" — `Change Risk Anti-Patterns = complexity² × (1−coverage)³ + complexity`) describing a *reactive* loop: an agent writes code into a shared, evolving codebase, a metric scores what already exists, another agent patches what's flagged. weir's node isolation sidesteps the failure mode that loop exists to catch — there's no shared, continuously-edited function for complexity to creep through, since every accepted implementation is either exactly right or gets thrown away and regenerated fresh. But *some* signal about what's inside an accepted black box is still worth keeping, purely as analytics — explicitly **not** fed back to gate acceptance or optimized against by agents (per direct instruction: no automatic behavior, no incentive to game a number).

## Design

### 1. Sealed contract export

A pure function producing exactly what crosses the isolation boundary to an implementing agent — nothing about topology, sibling nodes, or design rationale, only what the `Fn` must structurally satisfy.

```ts
// spikes/ts-prototype/src/contract.ts

export interface ContractEdgeShape {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: Record<string, NetlistField>;
}

export type ContractInputSpec =
  | ContractEdgeShape
  | { allOf: ContractEdgeShape[] };

export type ContractOutputSpec =
  | ContractEdgeShape
  | { oneOf: ContractEdgeShape[] }
  | { allOf: ContractEdgeShape[] }
  | { many: ContractEdgeShape };

export interface SealedContract {
  node: string;
  input: ContractInputSpec;
  output: ContractOutputSpec;
  description?: string;
  examples?: NodeDecl["examples"];
  closure?: NodeDecl["closure"];
  /** Fn may always return this instead of `output` — Failed<In>'s real shape, docs/design.md §3. */
  failure: { input: ContractInputSpec; reason?: string };
}

export function exportContract(node: NodeDecl): SealedContract;
```

Mirrors `netlist.ts`'s existing `NetlistInputSpec`/`NetlistOutputSpec` tagging convention (bare / `{allOf}` / `{oneOf}` / `{many}`, presence-of-key as discriminant, same idiom used everywhere else in this codebase) — except edges are embedded in full (`ContractEdgeShape`, real field definitions) rather than referenced by bare name, since an isolated agent has no other file to resolve a name against. `ContractInputSpec` deliberately has no `anyOf` branch: checked directly against `types.ts`, `InputSpec`'s real runtime type is only `{kind:"single"} | {kind:"allOf"}` — `anyOf` is pure `.node`-file authoring sugar, fully desugared into separate single-input `NodeDecl`s before elaboration ever produces a real one (`elaborate.ts`'s `parseAnyOfNodeFile`), so a `NodeDecl` passed to `exportContract` can never carry it. Including an unreachable branch here would be the same category of defect flagged earlier this session (a shape nothing can ever produce), not a completeness gesture.

**Reuses `netlist.ts`'s field-serialization logic rather than duplicating it.** `netlist.ts`'s private `serializeField` (the `many`/compound-edge/literal/scalar discriminant) is exported and reused directly; `contract.ts` adds its own small `edgeShape(edge: AnyEdgeDef): ContractEdgeShape` that calls it per-field and assembles the wrapper — deliberately not `NetlistEdge` (which requires a `schemaHash`, irrelevant here: staleness tracking has nothing to do with what an isolated agent needs to write correct code).

`failure`'s `input` reuses the same edge-shape computation as the contract's own `input` — `Failed<In>`'s real type (`types.ts`) is `{ input: InputPayload<In>; reason?: string }`, so this is the same shape, not a new concept, just made explicit in the JSON an agent actually receives rather than left to prose.

### 2. Implementation metadata

A pure function deriving facts about an accepted implementation's source, via the TypeScript compiler API (`typescript`, already a dependency — no new package needed).

```ts
// spikes/ts-prototype/src/metadata.ts

export interface ImplementationMetadata {
  lines: number;
  complexity: number;
}

export function computeImplementationMetadata(source: string): ImplementationMetadata;
```

- `lines`: `source.trim().split("\n").length`.
- `complexity`: McCabe cyclomatic complexity — starts at 1, walks the parsed AST (`ts.createSourceFile`), increments once per decision point: `IfStatement`, `ForStatement`/`ForInStatement`/`ForOfStatement`, `WhileStatement`/`DoStatement`, each non-default `CaseClause`, `CatchClause`, `ConditionalExpression` (ternary), and each `&&`/`||` `BinaryExpression`. Standard, same definition the CRAP post's own CC ceiling and most JS/TS complexity linters use.

**Deliberately not a CRAP-style composite score.** CRAP's own formula needs a coverage term (`(1 − coverage)³`); nothing in this spike instruments coverage, and computing a composite against an assumed-zero coverage would make every function score as if untested and complex — worse than useless, actively misleading. Raw facts only. A composite score is real, but separate, follow-on work once coverage data actually exists — not something to fake now to look more finished.

**Storage:** `<node>/<hash>.meta.json`, sibling to the existing `<node>/<hash>.ts` implementation file — matching the per-contract-hash-directory convention `design-history.md`'s versioning section already established (one accepted implementation per contract state, never overwritten). **Never read by the elaborator, `hash.ts`, or any acceptance logic** — a side-channel only, per explicit instruction: no automatic behavior change, nothing for an agent to optimize against.

**Not wired into a write pipeline in this pass.** No "accept an implementation" driver function exists yet anywhere in this spike — implementations are currently hand-authored directly into temp directories by tests (`runtime.test.ts`'s pattern: construct a `.ts` source string, write it to `<dir>/<node>/<hash>.ts`). `computeImplementationMetadata` is demonstrated by direct unit tests against source strings; wiring `<hash>.meta.json` writes into a real acceptance flow waits until that flow itself exists.

### Both exported from `index.ts`

`exportContract`, `SealedContract` and friends, `computeImplementationMetadata`, `ImplementationMetadata` — matching the precedent already corrected once this session (`LiteralFieldDef`/`defineLiteral` needed adding to `index.ts` to match their exported siblings `FieldDef`/`defineField`). These are meant to be real public API for whatever dispatches an isolated agent eventually, not internal-only helpers.

## Explicitly out of scope

- Actually invoking an LLM/agent to write a `Fn` body — no such capability exists in this spike, and building it is a separate, much larger piece of infrastructure.
- A real "acceptance" pipeline (generate → validate against examples/property tests → persist `.ts` + `.meta.json` together) — `computeImplementationMetadata` is built and tested standalone; wiring it into a pipeline waits until the pipeline exists.
- A CRAP-style composite score, or any threshold/gate derived from `complexity`/`lines` — analytics only, explicitly never automatic.
- Property-based test generation feeding `exportContract`'s acceptance story (`design-history.md`'s already-named-but-unbuilt generator mechanism, §6) — real and related, but separately scoped, unbuilt work.
- Anything about *how* an agent is actually isolated at the infrastructure level (fresh subagent, fresh API session, etc.) — `exportContract`'s job is producing the sealed payload; what carries it to an isolated agent is a deployment/tooling concern, not a weir-core one.
