# The acceptance pipeline: generate → validate → persist

Status: designed.

## Motivation

`design.md` §10 names the accept-before-persist gate directly: an implementation "is written once it passes both its examples and generated property cases (§6), never overwritten." `getting-started.md`'s build-order step 3 has named this the last unbuilt half of the authoring format since it was written: `resolveImplementation` (`implementation.ts`) *reads* `{node-name}/<contract-hash>.ts` by convention, but nothing has ever *written* one. Both prior specs this session named it directly as the reason they exist — the sealed-contract spec's "explicitly out of scope" section calls it "a real acceptance pipeline... wiring it into a pipeline waits until the pipeline exists," and the generator/fuzz-harness spec's motivation section names the generator as this pipeline's prerequisite. Both prerequisites are now built. This spec is the pipeline.

**What "generated property cases" means here, decided explicitly rather than assumed.** `design.md` §6 also names real property assertions (`∀ p . birthday(p).age == p.age + 1`) as a node declaration carries alongside examples — a semantic-correctness DSL that doesn't exist yet, and designing it is separate, substantially larger, undesigned work (no representation in `types.ts`, no assertion language, no evaluator). This pipeline uses only what's already built: examples checked by exact equality, and generated cases checked *structurally* via `fuzzNode` — does the result match the declared output shape, or `Failed<In>`? That's a real, meaningful acceptance bar (it catches crashes and wrong-shaped returns) without waiting on the property DSL. §6's real property assertions remain future work this pipeline doesn't block on.

## Design

### 1. `acceptImplementation` — the entry point

```ts
// spikes/ts-prototype/src/accept.ts

export interface ExampleFailure {
  given: unknown;
  expected: unknown;
  actual: unknown;
}

export type AcceptanceResult =
  | { accepted: true; path: string; metadataPath: string }
  | { accepted: false; reason: "load-failed"; error: string }
  | { accepted: false; reason: "checks-failed"; exampleFailures: ExampleFailure[]; fuzzReport: FuzzReport };

export async function acceptImplementation(
  nodeDecl: NodeDecl,
  source: string,
  implRoot: string,
  opts?: { seed?: number; count?: number },
): Promise<AcceptanceResult>;
```

Takes a candidate implementation as **source text**, not an already-loaded `Fn` — this is the realistic shape of what crosses the isolation boundary from an agent (the sealed-contract spec's whole premise), and it's what `computeImplementationMetadata` already consumes. An already-loaded `Fn` would need its source supplied separately anyway (for both writing to disk and for metadata), which is exactly the kind of two-things-that-can-drift-apart this avoids.

### 2. Flow

1. **Hash the contract.** `const { short } = await hashNode(nodeDecl)` — the same hash `resolveImplementation` already reads by (`hash.ts`, unchanged).
2. **Refuse a repeat.** If `${implRoot}/${nodeDecl.name}/${short}.ts` already exists, **throw** (not a rejection result). Since the hash is a pure structural fingerprint, the same contract always resolves to the same path — a second call against an unchanged contract is always a caller mistake (a retry-happy dispatcher not checking whether acceptance already succeeded, or an attempt to force regeneration without changing the contract, which `design-history.md`'s "walked-back detour" explicitly rejects as a storage case to design around). Matches `resolveImplementation`'s own convention of throwing loud on a violated invariant rather than accommodating it. Retrying after a *rejected* attempt is unaffected — nothing is ever written at that path until real acceptance, so there's nothing to collide with.
3. **Load the draft.** Write `source` to a fresh temp directory (`fs.mkdtemp` under the OS temp dir — the same pattern `implementation.test.ts`'s own fixtures already use), dynamically `import()` it. If the import throws (syntax error, runtime error at module-eval time) or the module's `default` export isn't a function, that's a **rejection** (`reason: "load-failed"`), not a thrown error — a draft that doesn't even load is exactly as legitimate an outcome as one that loads but fails its checks; an isolated agent's draft attempt can fail in either way, and both are "try again," not "something is broken in the pipeline itself." Delete the temp directory before returning.
4. **Check it**, always running both, never short-circuiting on the first failure (matching `assertPayload`'s/`FuzzReport`'s existing "collect everything, don't stop at the first violation" idiom — a caller iterating toward acceptance benefits from seeing every gap at once, not one at a time):
   - **Examples**: for each of `nodeDecl.examples ?? []`, invoke via `membrane(nodeDef)` (never `fn` directly — the same "reuse the real boundary" principle the fuzz harness already established) and compare the result against `.expect` with `node:util`'s `isDeepStrictEqual`. A mismatch is an `ExampleFailure`, including the case where `membrane` resolved to `Failed<In>` instead of a real result — no special-casing needed, a `Failed<In>`-shaped value simply won't deep-equal a declared `OutputResult<O>`.
   - **Generated cases**: `await fuzzNode(nodeDef, opts)`, unmodified — the harness this pipeline exists to use.
5. **Decide.** Accepted iff `exampleFailures.length === 0 && fuzzReport.failures.length === 0`. Otherwise, `reason: "checks-failed"` carrying both result sets in full (even if one of the two was clean — a caller sees the complete picture, matching step 4's "always run both"), and the temp directory is removed before returning — same as the `load-failed` cleanup in step 3, nothing about a candidate persists on any rejection path.
6. **Persist, only on acceptance.** Copy the temp file's contents to `${implRoot}/${nodeDecl.name}/${short}.ts` (creating the `${nodeDecl.name}/` directory if needed), then remove the temp directory — a copy, not `fs.rename`, since the OS temp dir and `implRoot` aren't guaranteed to be on the same filesystem (a cross-device `rename` fails with `EXDEV`); a same-directory move is a micro-optimization not worth the portability risk here. Compute `computeImplementationMetadata(source)` and write it to the sibling `${short}.meta.json` — matching `design-history.md`'s own description of that file's purpose ("stored as `<node>/<hash>.meta.json` sibling to the implementation file"), and closing the loop this session's first spec opened: metadata is computed, and now actually persisted, still never read by anything downstream (elaborator, `hash.ts`, acceptance logic itself) — purely a side-channel record of what was accepted. Return `{ accepted: true, path, metadataPath }`.

**Temp-directory cleanup is unconditional across all three outcomes** (`load-failed`, `checks-failed`, accepted) — the only difference is *when* it happens relative to copying the file out on acceptance. No path leaves a stray temp directory behind, checked directly by this spec's own last test case.

### 3. What this does *not* do

- Does not invoke an agent, or decide what candidate source to try next on rejection — a caller (out of scope for this spike, same as the sealed-contract spec's own boundary) is responsible for the retry loop; this function is one attempt, one verdict.
- Does not check real semantic correctness beyond what examples pin down exactly — see Motivation. A candidate that passes every example and every generated structural check can still be behaviorally wrong in ways no example happened to catch; that's the known, named limitation of skipping the property-assertion DSL, not a bug in this pipeline.
- Does not touch `resolveImplementation`'s read path, `elaborate.ts`, or any `.node`/`.edge`/`.topology` format — purely additive, the same "spike, not a host-language commitment" scope every module in `spikes/ts-prototype/` carries.

## Testing

TDD, mirroring `implementation.test.ts`'s existing temp-dir fixture style:
- A correct candidate is accepted: file exists at the exact expected path, metadata file exists alongside it with sane `lines`/`complexity` values, return value matches.
- A candidate failing an example is rejected with the specific mismatch (given/expected/actual all present and correct).
- A candidate failing generated-case checks is rejected with a `FuzzReport` whose `failures` are non-empty.
- A candidate failing both is rejected with both non-empty — proving step 4 never short-circuits.
- A candidate with a syntax error, and separately one with no default export, both reject with `reason: "load-failed"` and no file left behind (temp dir cleaned up either way).
- Calling again against an already-accepted contract hash throws, naming the node and the hash.
- Nothing is written to `implRoot` on any rejection path — assert the directory `readdir`s empty (or lacks the node's subdirectory) after each rejection case.
