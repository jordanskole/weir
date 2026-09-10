# Edge spread: `...Name` inside a `.edge`'s `fields:`

Status: implemented.

## Motivation

`design.md` §2 decided edges could spread one another's fields (`...Animal`-shaped notation) and every design-history entry about the `literal` field kind uses it as the motivating example (`edge CompletedTodo { ...Todo, is_complete: true }`) — but nobody ever built it. Checked directly: `edgeSchema()`'s field-value `oneOf` recognizes exactly four shapes (bare-string reference, typed field, `{ many }`, literal) and none of them is spread; `elaborate.ts`'s `parseEdgeFile` has no handling for it either.

The concrete cost of that gap is sitting in `examples/recipe/src/edges/`: `Dough.edge`, `BakedCookies.edge`, and `Cookies.edge` hand-duplicate `title`/`servings` verbatim across three files, with no declared relationship between them, even though the domain is explicit that they're the same dish at three successive stages (`Dough.edge`'s own description: "the same dish as Recipe, one real stage further along"). This was raised as an alternative to `fixed.pin` (`docs/superpowers/specs/2026-09-09-fixed-pin-node-defaults.md`, now paused) for `CreateTodo.node`'s "caller shouldn't set `is_complete`" problem — a second, nominally distinct input edge built with spread, rather than a node-scoped narrowing declaration. Preferred as more declarative and better separated: the creation-shaped input becomes its own real, named edge, not an annotation on an existing one.

## Design

### Semantics

Spread is **purely structural sugar, resolved once at elaboration time, with no relationship retained afterward** — copy a source edge's fields into a new edge's field map, apply local overrides, done. Not inheritance: no subtyping, no dispatch, nothing downstream (`hash.ts`, `netlist.ts`, `membrane.ts`, a node's `Fn`) ever knows a given edge was built with spread rather than typed out by hand in full. The precedent is Rust's struct-update syntax (`Foo { done: true, ..a }`) — composition-shaped reuse at a single point in time, not a live is-a relationship — not classical OOP inheritance, and it doesn't inherit inheritance's actual problems (fragile base class, diamond ambiguity) because there's no dispatch for a base-class change to silently break.

**Single source only.** `edge X { ...A, ...B, ... }` is a parse error. Matches Rust's own choice (`..a` — never two) and sidesteps the diamond problem (whose field wins on a name collision between two spread sources) entirely rather than needing a resolution rule for it. Multiple sources can be revisited later if a real case needs it; none has yet.

**Override is whole-field replacement, not a sub-field patch.** A local key with the same name as one of the source edge's fields fully replaces that field's definition — type, label, description, everything — the same way `CompletedTodo`'s `is_complete: true` was always meant to replace `Todo.is_complete` outright, not patch one property of it. Declaration order inside `fields:` doesn't matter: the spread key can appear anywhere, and every local (non-spread) key wins over the source regardless of where it's written.

**`index` inherits from the spread source when not locally redeclared.** Not discussed explicitly before writing this spec, added here because the alternative is silently wrong: `CompletedTodo` spreading `Todo` (which declares `index: id`) should obviously still be indexed by `id` — losing that by default would be a real, easy-to-miss correctness regression on every spread-built edge that has an identity field, not a neutral omission. A local `index:` still overrides it, same rule as fields.

### Syntax

```yaml
fields:
  ...Dough:
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat
```

The spread key is `...` followed by the source edge's name, with an empty (`null`) value — YAML's plain "key with nothing after the colon" shorthand. Not the bare `...Dough` (no colon) floated during design: that's not valid YAML inside a mapping, and three dots alone at the start of a line is YAML's reserved document-end marker — `...Dough:` (immediately followed by more characters, never alone on its line) is a distinct token to a compliant parser, but this is exactly the kind of thing to verify with a real parser test during implementation, not just assumed correct from reading the spec.

### Mechanics

**`schema.ts`'s `edgeSchema()`**: `fields:`'s object schema gains a `patternProperties` entry matching `^\.\.\..+$`, validated as `{ type: "null" }` — a spread key exists only to be present, its value carries no information and a non-null value is a validation error, not silently ignored. Left independent of the existing `additionalProperties` (the four real-field shapes) — JSON Schema composes `patternProperties` and `additionalProperties` natively: a key matching the pattern validates against the pattern's schema, every other key still validates as a real field, unchanged. Whether more than one spread key is present isn't checkable at this layer (same reason cross-file edge-name matching already isn't — `tagged()`'s doc comment: that's the elaborator's job).

**`elaborate.ts`'s `parseEdgeFile`**: before processing `fields:`'s entries, scan them for keys matching `/^\.\.\.(.+)$/`. Zero matches: unchanged behavior. More than one: throw (`"fields" may spread from at most one source, found N: ...`). Exactly one: extract the source name (the part after `...`), resolve it via the same `FieldResolver` already used for bare-string field references (`email: email` → the `Email` edge/field), reject it if the resolved thing isn't an edge (`!("fields" in resolved)` — the same check `many:` already uses for the same reason, "many is for edges only" generalized to "spread is for edges only"), and seed `resolvedFields` from the source's own `fields` before the existing per-key loop runs (skipping the spread key itself in that loop, so it's never mistaken for a real field). Local keys processed afterward overwrite same-named entries from the seed, giving override-wins regardless of declaration order. `index` inherits from the resolved source's own `index` unless the local file declares its own.

**No change needed to the TS-level `defineEdge` API.** Confirmed while writing this spec: plain JavaScript/TypeScript object spread already does exactly what's being designed here — `defineEdge({ ..., fields: { ...Dough.fields, done: defineField({...}) } })` works today, unchanged, with zero new code, because `Dough.fields` is already an ordinary JS object. This is different from `oneOf`/`anyOf` input, which needed `defineAnyOfNodes` as a TS-level equivalent of YAML desugaring — spread doesn't need an equivalent because the host language already has real spread built in. Only the YAML-authoring path (`parseEdgeFile`, `edgeSchema()`) needs new code.

### Applied to the real recipe fixtures

```yaml
# Dough.edge — unchanged, the root of the chain
label: Dough
description: The recipe's ingredients, combined and ready to bake — the same dish as Recipe, one real stage further along (see README)
fields:
  title:
    type: utf8
    label: Title
    description: The name of the dish being made
    nullable: false
    validations:
      minLength: 3
      maxLength: 200
  servings:
    type: uint8
    label: Servings
    description: How many servings this batch makes
    nullable: false
    validations:
      min: 1
      max: 100
```

```yaml
# BakedCookies.edge — spreads Dough, adds done as a real mutable bool
label: Baked Cookies
description: The dough, baked — still too hot to eat
fields:
  ...Dough:
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat
```

```yaml
# Cookies.edge — spreads BakedCookies, pins done to true (this stage is finished, by definition)
label: Cookies
description: The finished, cooled cookies — ready to eat
fields:
  ...BakedCookies:
  done: true
```

`Recipe.edge` is intentionally left alone — it has its own `temperature`/`ingredients` fields `Dough` doesn't carry forward (mixing a recipe consumes/transforms those inputs rather than passing them through), so spreading it into `Dough` would pull in fields that don't belong there. Not every edge in a lifecycle needs to be in the spread chain; only where the shape is genuinely a superset.

## Explicitly out of scope

- Multiple spread sources in one `fields:` map (`{ ...A, ...B }`) — single-source only, per the Rust-struct-update precedent above.
- Any retained relationship between a spread-built edge and its source (queryable "variants of X," routing implications, etc.) — purely structural, resolved and erased at elaboration time.
- A `variants:`-nested alternative syntax (owning several named variants inside one base edge's file) — considered, set aside because the concrete motivating case (`Dough`→`BakedCookies`→`Cookies`) is a chain, not a hub, and free-standing spread handles both shapes uniformly without new elaboration machinery or a conflict with "an edge's name is derived from its filename."
- Sub-field-level override (patching one property of a source field rather than replacing it whole) — whole-field replacement only.
- Generalizing the `literal` field kind past booleans — unrelated to this spec; was part of the now-paused `fixed.pin` work and not needed by any example here (`done: true` is already a plain bool).
