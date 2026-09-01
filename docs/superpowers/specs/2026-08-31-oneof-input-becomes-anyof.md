# Input `oneOf` becomes `anyOf`

Status: approved design, not yet implemented.
Follows: `docs/superpowers/specs/2026-08-31-any-desugaring-design.md`, which built input `oneOf` (as `any`'s replacement) earlier the same day. This spec corrects that naming, not the mechanism.

## Motivation

Spot-checked (independently, by a second conversation with the same conclusion) after the `any`→`oneOf` work landed: weir now uses "`oneOf`" for two genuinely different things.

**Output `oneOf`** (`types.ts`'s `OutputSpec`, unchanged, pre-existing): `OutputResult` for this kind is a union type (`Tagged<A> | Tagged<B> | ...`) — `Fn` returns one value, so the type system guarantees exactly one branch every call. True "exactly one," enforced by the compiler. Matches JSON Schema's own `oneOf` keyword ("exactly one subschema validates"), which `schema.ts` also uses natively for its own combinator logic elsewhere in the same file.

**Input `oneOf`** (`elaborate.ts`'s `parseOneOfNodeFile`, built earlier today): desugars into N completely independent single-input nodes, each firing on its own edge with **no exclusivity between them** — deliberately, per that spec's own "no cross-shadow exclusivity" correction. If two listed edges both show up in one invocation, both shadows fire. The group produces zero, one, or up to N firings — never guaranteed exactly one. That's JSON Schema's `anyOf` semantics ("one or more validate"), not its `oneOf` semantics.

The naming mistake traces to one sentence in the prior spec's own reasoning: "`oneOf` won: it's `oneOf`'s own dual on the input side (a coproduct — exactly one of several concrete types is relevant **per firing**)." "Per firing" is true of any individual shadow in isolation but glosses over the fact that the group isn't exclusive across firings — the analogy holds at the wrong grain.

**Resolved naming matrix**, settled directly rather than re-derived:

| | input | output |
|---|---|---|
| `allOf` | all must be present | all fire |
| `anyOf` | one or more may fire, independently | — |
| `oneOf` | — | exactly one fires |

`allOf` stays genuinely dual (same word, same "product" meaning, either position — matching `single`'s existing dual-position precedent). `anyOf` and `oneOf` are **not** dual after this change — each is single-position only. There is no "output anyOf": a single `Fn` call returns exactly one value, so "zero or more of these may fire from one call" has no coherent output-side meaning the way it does on the input side (multiple independent node firings). No new output-side work follows from this rename.

## Scope: pure rename, zero behavior change

Input `oneOf`'s mechanism — `parseOneOfNodeFile`'s desugaring into N single-input `NodeDecl`s, the `<Name>__<EdgeName>` naming, the `.topology` alias expansion, `defineOneOfNodes`, the "no cross-shadow exclusivity" firing behavior — is unchanged and correctly reasoned; only identifiers change. Smaller in scope than the `every`→`allOf` rename it mirrors: input `oneOf` never became a runtime `InputSpec` kind (it's pure elaboration-time sugar), so this touches neither `types.ts`'s `InputSpec`/`InputPayload`, nor `membrane.ts`, nor `runtime.ts`, nor `hash.ts` — none of those files ever recognized `oneOf` as an input concept at all.

## What changes

- `elaborate.ts`: `parseOneOfNodeFile` → `parseAnyOfNodeFile` (function name and its doc comment); the node-loading loop's `isOneOf` detection (`"oneOf" in raw.input`) → `isAnyOf` (`"anyOf" in raw.input`); `oneOfAliases` → `anyOfAliases`. `resolveEdgeNameList(input?.oneOf, "input.oneOf", ...)` inside the renamed function → `input?.anyOf`, `"input.anyOf"`.
- `define.ts`: `defineOneOfNodes` → `defineAnyOfNodes`, doc comment updated (still describes itself as the TS-level equivalent of the elaborator's desugaring, now naming `parseAnyOfNodeFile`).
- `schema.ts`: **only** the input-position conditional and property entry — `nodeSchema()`'s `if: {properties: {input: {type:"object", required:["oneOf"]}}}` conditional (currently commented "oneOf (input position)...") → `required: ["anyOf"]`, comment updated; `properties.input`'s `{properties: {oneOf: edgeNameList}, required: ["oneOf"]}` entry → `{properties: {anyOf: edgeNameList}, required: ["anyOf"]}`. The `given` shape stays `taggedOne(objectPayload)` — unchanged, since an individual authored example still demonstrates exactly one triggering edge; only the property key renames. **Do not touch** the output-position `oneOf` conditional/entries, or any of `nodeSchema()`'s own native JSON-Schema `oneOf` combinator usages (the `oneOf: [...]` alternative-shape lists at `input`/`output`'s top level, and inside `fieldSchema()`) — those are JSON Schema's own keyword, unrelated to weir's semantic property, and must stay exactly as-is.
- Real `.node` files: none use `oneOf`-shaped input today (`examples/todo-list`, `examples/person-birthday` — neither declares it), so no example fixture needs updating. (`AddTodoToList.node` uses `allOf:`, already renamed in the prior pass — untouched here.)
- `schemas/node.schema.json`: regenerate; diff should show only the `oneOf`→`anyOf` key rename on the input side.
- Test files (`elaborate.test.ts`, `schema.test.ts`, `runtime.test.ts`, `define.test.ts`): rename every input-`oneOf`-referring test name, YAML string, and JSON payload to `anyOf`. **Leave untouched**: every output-`oneOf` test (`elaborate.test.ts`'s "resolves a oneOf output...", the `expect_Person_age_42` fixture and its `kind: "oneOf"` assertion at `elaborate.test.ts:862-865`; `node.test.ts`'s "types a oneOf node..." — `output: oneOf(Pass, Fail)`; `runtime.test.ts`'s output-`oneOf` routing tests) — all genuinely output-side and correctly named already.
- `docs/design-history.md`: one new entry recording the correction — what was wrong, why, the resolved matrix, that this is a same-day follow-up to the `any`→`oneOf`/`every`→`allOf` entry.
- No `docs/design.md`/`docs/open-questions.md` changes expected — neither document ever described input-`oneOf` syntax (it didn't exist until today, and both were already checked for stray `every:` mentions in the prior pass, not `oneOf`). Confirm via grep during implementation rather than assuming.

## Explicitly out of scope

- Any change to output `oneOf`, `allOf`, `many`, or `single` — untouched, correctly named already.
- Building an output-side `anyOf` — no coherent meaning exists for it, per the Motivation section's matrix; not a placeholder, a genuine non-goal.
- Any change to `every`→`allOf` (separate, already-completed, unrelated work).
