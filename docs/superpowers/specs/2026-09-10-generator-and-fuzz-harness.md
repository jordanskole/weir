# Property-test generation and a structural fuzz harness

Status: designed.

## Motivation

`design.md` §6 named this mechanism without ever specifying how it runs: *"Edge definitions double as generator specs (`age: uint8` supplies the domain, `enumValues` the cases), so property tests are close to free here."* `design-history.md` ("Property tests are generation, not mocking") concretized the idea — a per-field generator derived from `FieldDef`'s own `type`/`enumValues`/`validations`, composed into a whole-edge generator, the same "mechanically derivable from the same types" move `contract.ts` and `schema.ts` already make off the same source — but stopped short of building it. This spec is that mechanism.

It follows directly from the sealed-contract/metadata work (`docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md`): that spec's own "explicitly out of scope" section named "a real acceptance pipeline (generate → validate against examples/property tests → persist)" as separate, unbuilt work, and named the generator mechanism itself as a prerequisite piece. This spec builds the generator, plus a minimal harness that runs generated cases through a node's real `Fn` and checks the result is *structurally* well-formed — catching crashes and wrong-shaped returns without requiring the "properties" assertion DSL (`∀ p . ...`, §6) to exist. That DSL — declaring and checking semantic invariants against generated cases — is real, related, and explicitly **not** part of this spec; see Out of scope.

## Design

### 1. Generation — `generate.ts`

A pure module, dependent only on `types.ts`. No dependency on `Fn`, `membrane`, or node declarations — it generates payloads from edge/field shapes alone, the same layering `contract.ts` (edge shapes only) keeps relative to `metadata.ts` (implementation source only).

**Determinism.** A small inline seeded PRNG (mulberry32-shaped — one `uint32` seed, one multiply-xorshift step per call — no new dependency, matching this repo's existing "no library named here" stance on generators and TDD's requirement for reproducible test failures). `createRng(seed: number): () => number` returns a `[0, 1)` generator; everything else in this module is built on top of it. Same seed, same `count` → byte-identical output, always — this is what makes `generate.test.ts` (and any future consumer) a deterministic suite rather than a flaky one.

**Boundary-biased sampling**, not uniform. `design-history.md` frames generated cases as "unbiased breadth a human wouldn't think to write by hand" — boundary values (an inclusive range's endpoints, zero, empty/longest strings, first/last enum value) are exactly the cases a hand-written example set is least likely to include, and where off-by-one bugs actually live. Per field, a generation batch mixes a fixed boundary set with uniform-random fill:

- **Numeric** (`uint8`/`uint16`/`uint32`/`int8`/`int16`/`int32`/`f32`/`f64`): bounds from `validations.min`/`max` when declared, else `INTEGER_RANGES[type]` (already exported from `define.ts` — reused, not re-derived) for integer types, unbounded for `f32`/`f64`. Boundary set: `[min, max, min+1, max-1, 0-if-in-range]`, deduplicated; remaining slots filled uniform-random within bounds.
- **String** (`utf8`, `datetime`): bounds from `validations.minLength`/`maxLength`, default `[0, 64]` when undeclared (unbounded string length has no meaningful "boundary" otherwise). Boundary set: shortest and longest allowed length, each filled with random printable characters; `datetime` fields generate a valid ISO-8601 string at boundary/random points in a fixed reasonable date range, never raw garbage, since `datetime`'s domain is "valid ISO-8601 strings," not "any string of the right length." **A field declaring `validations.pattern` throws immediately, naming the field** — satisfying an arbitrary regex generatively is real, unattempted complexity; no edge in this repo declares `pattern` today (checked directly), so this costs nothing now and fails loudly, not silently-wrong, the moment one does. Same idiom `define.ts`'s own `validateField` already uses for other unsupported/invalid configurations.
- **`enumValues`** (any string field that declares it): cycles through every declared value at least once across a batch before repeating, then uniform-random pick — guarantees full enum coverage isn't left to chance for a small `count`.
- **`bool`**: alternates `true`/`false`.
- **`LiteralFieldDef`**: always its pinned constant — nothing to vary, matching `assertPayload`'s own treatment of literal fields as "a payload value either matches it or doesn't, nothing else to check."

**Recursion.** `generatePayload(edge: AnyEdgeDef, rng): unknown` walks `edge.fields` and recurses into compound (a nested `AnyEdgeDef`) and `many` fields — same three-way discriminant `assertPayload`/`hash.ts`'s `fingerprint()` already use (`"many" in field` / `"fields" in field` / scalar), applied here to generate instead of validate. A `many` field generates a small (0–3) random-length collection, keyed by the referenced edge's own declared `index` — matching `Payload`'s existing keyed-collection shape, never a bare array.

**Entry point.** `generateInputCases(input: InputSpec, seed: number, count: number): unknown[]`:
- `single` → `count` calls to `generatePayload(input.edge, rng)`.
- `allOf` → `count` bags, each built by generating every declared edge and keying the bag by edge name — matching `InputPayload`'s existing `allOf` shape (`{ [edgeName]: PayloadOf<edge> }`).

Independently unit-testable against fixtures shaped like `contract.test.ts`'s (`Person`, `Todo`, `TodoList`, etc.) with no need for a real `NodeDef`.

### 2. The fuzz harness — `fuzz.ts`

Depends on `generate.ts` and `membrane.ts`. `fuzzNode(nodeDef: NodeDef, opts?: { seed?: number; count?: number }): Promise<FuzzReport>` (defaults: a fixed seed for reproducible default runs, `count: 100`).

**Invocation goes through `membrane(nodeDef)`, not `Fn` directly.** This reuses real, already-tested production code — input `assertPayload`, envelope-building, `scope`/identity narrowing, and `Failed<In>` routing on a caught throw — the exact path a node actually runs in the runtime, rather than a parallel hand-rolled one. The direct consequence, decided explicitly rather than discovered as a surprise: `membrane()`'s own stated job is that *"nothing escapes the boundary as an exception"* (`design.md` §3), so a real `Fn` crash and a deliberate `Failed<In>` return are indistinguishable by the time a result reaches the harness — both are `{ input, reason? }`. That's accepted as correct, not a gap: per `design.md`, every node's real output signature is "one of `{successes, Failed}`," so a generated input landing in `Failed<In>` is always a legitimate outcome, never on its own evidence of a bug.

**Per case:**
- `single`-input node: generate `count` payloads, call `membrane(nodeDef)` with each directly.
- `allOf`-input node: generate `count` bags; for each, build a fresh `InMemoryLog` (`membrane.ts`, already exported), `.append` each edge's generated payload under a synthetic per-case correlation id, then call the `allOf` invoke against that log — the shape `membrane()`'s `allOf` path already expects, reused rather than bypassed.

**Result validation.** A case is accepted (not a failure) if the result matches *either*:
- the declared `OutputSpec`, checked structurally: `single`/`many` → `assertPayload` against the output edge; `oneOf` → the tagged branch's `.edge` must be one of the declared edges, its `.payload` asserted against that edge; `allOf` → every declared edge present and tagged, each asserted. (No existing function does this dispatch-and-assert — `runtime.ts`'s `logOutput` blindly casts without validating. This is genuinely new, reusing `assertPayload` per branch rather than duplicating its logic.)
- *or* `Failed<In>`'s shape (`{ input }` / `{ input, reason }` — reusing the same shape check `runtime.ts`'s `looksLikeFailed` already documents as a heuristic, imported rather than re-derived).

Anything else — a result matching neither — is a recorded failure.

**Report shape**, collecting every case rather than stopping at the first (matching `assertPayload`'s own "collect every violation" convention):

```ts
export interface FuzzReport {
  total: number;
  passed: number;
  failures: { input: unknown; error: string }[];
}
```

### 3. Testing

TDD throughout, per this repo's global convention.

- `generate.test.ts`: same seed twice → identical output (determinism); a numeric/string/enum field's boundary values actually appear across a batch; recursion into compound and `many` fields produces payloads that pass `assertPayload` against their edge; a field declaring `pattern` throws, naming the field.
- `fuzz.test.ts`: a deliberately-broken `Fn` (returns a shape matching neither its `OutputSpec` nor `Failed<In>`) is recorded as a failure; an `Fn` that legitimately returns `Failed<In>` for some/all generated inputs is never reported as a failure; a correct `Fn` fuzzed against its own declared contract produces `passed === total`; an `allOf`-input node fuzzes correctly through the `InMemoryLog` path.

## Explicitly out of scope

- **A property-assertion DSL** (`∀ p . birthday(p).age == p.age + 1`, §6) — declaring and checking semantic invariants against generated cases. This is the larger, genuinely undesigned piece §6 gestures at; nothing in `types.ts` represents a "property" today (only `examples`), and designing that representation is a separate spec.
- **Wiring into an acceptance pipeline** (generate → validate against examples/property cases → persist `.ts`+`.meta.json`, `design.md` §10) — named out of scope by the sealed-contract/metadata spec already, still true here. `fuzzNode` is built standalone and callable from tests today, the same shape `computeImplementationMetadata` was.
- **Any `.node`/`.edge`/`.topology` YAML changes** — this is TS-level only, same spike-scope caveat as everything in `spikes/ts-prototype/`.
- **Regex-pattern-satisfying string generation** — a field declaring `validations.pattern` throws rather than being generated around (§2.1 above); revisit only once a real edge needs it.
- **Shrinking** (fast-check/QuickCheck's minimal-counterexample search once a failure is found) — the report records every failing generated input as-is; reducing a failure to a minimal reproduction is real, separate work, not attempted here.
