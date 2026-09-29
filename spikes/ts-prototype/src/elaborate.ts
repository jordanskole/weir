/**
 * The elaborator: turns hand-authored `.field`/`.edge`/`.node`/`.topology`
 * YAML into validated `FieldDef`/`EdgeDef`/`NodeDecl`/`Wiring` objects
 * (docs/design.md §10). `.node` loading only resolves the contract —
 * `input`, `output`, `examples`, `closure`, `properties` — never `fn`, which
 * a data format can't hold (§10) and stays the implementation tree's job,
 * not this one's.
 *
 * `.field`/`.edge`/`.node` files don't declare their own `name` — the
 * filename *is* the name (a standalone file has no parent map to be a key
 * in, the way an inline field does, so the filename is the only thing that
 * could name it; making that the *only* source of truth means a mismatched
 * name isn't a bug to catch, it's not a representable state at all).
 * `.topology` is different in kind — a wiring description, not one more
 * named declaration — so it has no filename-as-name convention at all.
 */

import { glob, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse } from "yaml";
import { defineEdge, defineField } from "./define.js";
import { assertDeclaration } from "./schema.js";
import { failedEdgeName, failedAllOfEdgeName, failedGatherEdgeName, inputEdgeNames } from "./types.js";
import type { AnyEdgeDef, FieldDef, InputSpec, LiteralFieldDef, ManyEdgeDef, NodeDecl, OutputSpec } from "./types.js";

/**
 * `many` is a collection keyed by the referenced edge's own declared
 * `index` field, never a bare array (docs/design-history.md, "`many` is a
 * collection, keyed by index, not an array") — a collection needs a real
 * key, so an edge with no `index` can't be used inside a `many` at all.
 */
function requireIndex(edge: AnyEdgeDef, context: string): void {
  if (edge.index === undefined) {
    throw new Error(`${context} references "${edge.name}", which declares no index — a collection needs a real key.`);
  }
}

/**
 * Synthesizes one `Failed_<EdgeName>` edge per declared edge — `{ input:
 * <edge>, reason }` — so a `.node` file can declare `input: Failed_Todo`
 * without hand-authoring it (docs/design-history.md, "The runtime, built
 * narrow on purpose... `Failed<In>` routing"; naming convention shared
 * with `runtime.ts` via `failedEdgeName`). Iterates a snapshot of `edges`
 * taken before synthesis starts, so a synthesized `Failed_*` edge never
 * itself grows a `Failed_Failed_*` counterpart. Single-input nodes only —
 * `allOf`-input combos get their own synthesis (`synthesizeAllOfFailedEdges`,
 * below) since unconditional-for-every-edge doesn't generalize to
 * combinations (that's a powerset, not a linear scan).
 */
function reasonField(): FieldDef {
  return { type: "utf8", label: "Reason", description: "Why the node failed, if known.", nullable: true };
}

function synthesizeFailedEdges(edges: Record<string, AnyEdgeDef>): void {
  for (const edge of Object.values({ ...edges })) {
    const name = failedEdgeName(edge.name);
    if (name in edges) continue;
    edges[name] = defineEdge({
      name,
      label: `Failed (${edge.label})`,
      description: `A node that takes "${edge.name}" as input failed — the original input, plus why (docs/design.md §3).`,
      fields: { input: edge, reason: reasonField() },
    });
  }
}

/**
 * Synthesizes one `Failed_<A>_<B>` edge per distinct `allOf: [...]` combo
 * actually declared by some `.node` file — `{ <A's name>: A, <B's name>: B,
 * reason }`, flat rather than wrapped in an `input` field, since the bag
 * `allOf`'s payload already is a fixed multi-field shape, not a single
 * edge to embed (docs/design-history.md, "`any` built... every-input
 * Failed<In> still collects in failures"; naming convention shared with
 * `runtime.ts` via `failedAllOfEdgeName`).
 *
 * Unlike `synthesizeFailedEdges`, this can't run unconditionally for every
 * possible subset of declared edges — that's a powerset, not a linear scan
 * — so the caller must discover which combos are actually declared first
 * (a raw pre-scan of `.node` YAML, before the real `parseNodeFile` pass,
 * since a node might itself declare `input: Failed_A_B`).
 *
 * A combo member literally named "reason" would silently clobber the
 * reason field below (`defineEdge` does no field-name validation) — the
 * same unaddressed risk `synthesizeFailedEdges`'s `input`-named field
 * already carries; not guarded against here either, for the same reason
 * (no real edge in this repo collides today).
 */
/**
 * Synthesizes one `Failed_Many_<X>` edge per edge some `.node` file actually
 * declares `gather: X` on — `{ input: many X, reason }`
 * (docs/superpowers/specs/2026-09-27-gather.md §4).
 *
 * Conditional on a declaration, like `synthesizeAllOfFailedEdges` and unlike
 * `synthesizeFailedEdges`: a gather's failure edge is only meaningful where a
 * gather exists, and synthesizing one per declared edge would double the edge
 * table for nothing.
 *
 * The `many` field is what makes this expressible. A gather's `Failed<In>`
 * carries the partial collection, and a bare keyed collection is not an edge
 * payload — but a *field* may be `many` (`ManyEdgeDef`), so the collection
 * sits inside one that is. Nested under `input` rather than flattened, which
 * is `synthesizeFailedEdges`' shape rather than `synthesizeAllOfFailedEdges`':
 * a gather's input is one thing with one name, not a bag of several.
 */
function synthesizeGatherFailedEdges(edges: Record<string, AnyEdgeDef>, gathered: AnyEdgeDef[]): void {
  for (const edge of gathered) {
    const name = failedGatherEdgeName(edge.name);
    if (name in edges) continue;
    edges[name] = defineEdge({
      name,
      label: `Failed (gather of ${edge.label})`,
      description: `A node gathering "${edge.name}" failed — the collection it was holding, plus why. A gather is \`sequence\`, so one element's failure is the whole group's (docs/design.md §3).`,
      fields: { input: { many: edge }, reason: reasonField() },
    });
  }
}

function synthesizeAllOfFailedEdges(edges: Record<string, AnyEdgeDef>, combos: AnyEdgeDef[][]): void {
  for (const combo of combos) {
    const name = failedAllOfEdgeName(combo);
    if (name in edges) continue;
    const fields: Record<string, AnyEdgeDef | FieldDef> = { reason: reasonField() };
    for (const edge of combo) {
      fields[edge.name] = edge;
    }
    edges[name] = defineEdge({
      name,
      label: `Failed (${combo.map((edge) => edge.label).join(" + ")})`,
      description: `A node whose allOf: input required ${combo.map((edge) => edge.name).join(", ")} failed — the raw bag, plus why (docs/design.md §3).`,
      fields,
    });
  }
}

/**
 * Synthesizes one `noop_<EdgeName>` node per declared edge — `X -> X`, the
 * identity. A *system node* in the sense of `open-questions.md`: its contract
 * determines its implementation, so there is nothing for an agent to draft
 * and nothing for the acceptance gate to accept. No `fn`, no implementation
 * file keyed by contract hash, no declared examples, no property assertions.
 *
 * Its job is **terminating a branch inside a composite**
 * (docs/superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md §7).
 * A composite's `terminals` are the inner nodes whose outputs are its
 * declared output; when a branch's last real node does not itself produce
 * that shape, or when the branch simply needs a named exit, `noop_X` is what
 * it ends on. Declared rather than inferred, so the boundary is checkable at
 * elaboration instead of only observable at runtime.
 *
 * Synthesized per edge rather than as one polymorphic node, so the
 * declaration language needs no generics — the trick `synthesizeFailedEdges`
 * already uses, with one difference: **on reference, not unconditionally.**
 * An edge table is cheap and a node table is not; synthesizing `noop_X` for
 * every declared edge would put 2N unused nodes in every program (`Failed_X`
 * edges get noops too), which showed up immediately as every test asserting
 * a node list. Resolution is the natural place — it is the single point
 * where a wiring turns a name into a node — and it means `noop_Failed_X` is
 * available if a failure branch needs terminating while `noop_noop_X` is
 * never reachable, since no edge is named `noop_X`.
 *
 * What this is *not*, corrected once already: an explicit copy morphism.
 * Weir's arcs already copy — `feeds: { a: ["b", "c"] }` gives both the same
 * instance, because consumption is tracked per node — so `Δ` is free and
 * needs no node (design-history.md, "Correction: weir's arcs already copy").
 */
function synthesizeNoopNode(
  nodes: Record<string, NodeDecl>,
  edges: Record<string, AnyEdgeDef>,
  name: string,
): boolean {
  if (name in nodes) return true;
  const edgeName = name.startsWith("noop_") ? name.slice("noop_".length) : undefined;
  const edge = edgeName === undefined ? undefined : edges[edgeName];
  if (edge === undefined) return false;
  nodes[name] = {
    name,
    label: `No-op (${edge.label})`,
    description: `Passes a "${edge.name}" through unchanged — a branch terminal (docs/superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md).`,
    input: { kind: "single", edge },
    output: { kind: "single", edge },
  };
  return true;
}

/** Parse a `.field` file's YAML text into a validated FieldDef. */
export function parseFieldFile(yamlText: string): FieldDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  // Ahead of the schema check: the schema would reject `name` as an unknown
  // key, which is true but does not say why the key does not exist.
  if ("name" in raw) {
    throw new Error(`.field files don't declare "name" — the filename is the name.`);
  }
  assertDeclaration("field", raw);
  return defineField(raw as unknown as FieldDef);
}

/**
 * Given a bare-string field value (e.g. `email: email` or `address: Address`),
 * resolves it to the FieldDef/EdgeDef declared under that name — a sibling
 * `.field` or `.edge` file, whichever extension exists (docs/design.md §10's
 * "globs by extension" convention, applied one layer down).
 */
export type FieldResolver = (name: string) => FieldDef | AnyEdgeDef;

/** Names the field a failure came from, the way `inFile` names the file. */
function inField<T>(key: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw new Error(`field "${key}": ${(cause as Error).message}`, { cause });
  }
}

/** Matches a `.edge` file's `...Name` spread key (docs/superpowers/specs/2026-09-09-edge-spread.md), capturing the source edge's name. */
const SPREAD_KEY = /^\.\.\.(.+)$/;

/** Parse an `.edge` file's YAML text (and its filename-derived name) into a validated EdgeDef. */
export function parseEdgeFile(yamlText: string, name: string, resolveField: FieldResolver): AnyEdgeDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  // See parseFieldFile: a better message than "unknown key".
  if ("name" in raw) {
    throw new Error(`.edge files don't declare "name" — the filename is the name.`);
  }
  assertDeclaration("edge", raw);
  const { label, description, index, fields } = raw as {
    label?: unknown;
    description?: unknown;
    index?: unknown;
    fields?: Record<string, unknown>;
  };

  const fieldEntries = Object.entries(fields ?? {});
  const spreadEntries = fieldEntries.filter(([key]) => SPREAD_KEY.test(key));
  if (spreadEntries.length > 1) {
    throw new Error(
      `"fields" may spread from at most one source, found ${spreadEntries.length}: ${spreadEntries.map(([key]) => key).join(", ")}.`,
    );
  }

  const resolvedFields: Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  let spreadIndex: string | undefined;
  let spreadFrom: string | undefined;
  if (spreadEntries.length === 1) {
    const [spreadKey, spreadValue] = spreadEntries[0]!;
    if (spreadValue !== null && spreadValue !== undefined) {
      throw new Error(`"${spreadKey}" must have no value (null), got ${typeof spreadValue}.`);
    }
    const sourceName = spreadKey.match(SPREAD_KEY)![1]!;
    const source = resolveField(sourceName);
    if (!("fields" in source)) {
      throw new Error(`"...${sourceName}" references a field, not an edge — spread is for edges only.`);
    }
    Object.assign(resolvedFields, source.fields);
    spreadIndex = source.index;
    spreadFrom = sourceName;
  }

  for (const [key, value] of fieldEntries) {
    if (SPREAD_KEY.test(key)) continue;
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (typeof value === "boolean") {
      resolvedFields[key] = { literal: value };
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      requireIndex(resolved, `"${key}.many"`);
      resolvedFields[key] = { many: resolved };
    } else if (value !== null && typeof value === "object" && "literal" in value) {
      resolvedFields[key] = value as LiteralFieldDef;
    } else {
      // Through `defineField`, not cast. A `.field` file has always been
      // validated (parseFieldFile), but a field written *inline inside an
      // edge* — which is how nearly every field in this repo is written —
      // used to be cast straight to `FieldDef`, so every check
      // `validateField` performs was unreachable for the common case:
      // unknown types, `min` on a string, `minLength` on a bool.
      resolvedFields[key] = inField(key, () => defineField(value as FieldDef));
    }
  }

  // Cross-field, so no JSON Schema can express it: `index` names *this
  // edge's own* field, and until now a typo produced an edge whose key
  // pointed at nothing — silently, since every consumer reads `index` and
  // none checked it resolved.
  const resolvedIndex = typeof index === "string" ? index : spreadIndex;
  if (resolvedIndex !== undefined && !(resolvedIndex in resolvedFields)) {
    throw new Error(
      `index: "${resolvedIndex}" is not a field of this edge — declared fields are ${Object.keys(resolvedFields).join(", ") || "(none)"}.`,
    );
  }

  return defineEdge({
    name,
    label: label as string,
    description: description as string,
    ...(typeof index === "string" ? { index } : spreadIndex !== undefined && { index: spreadIndex }),
    ...(spreadFrom !== undefined && { spreadFrom }),
    fields: resolvedFields,
  });
}

/**
 * Parses a `.envelope` file — **through the edge parser**
 * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md §2).
 *
 * Reusing `parseEdgeFile` is the point rather than a convenience. An envelope
 * gets field types, validations, `enumValues`, nested edges and
 * `classification` for free, and nothing new has to be invented for any of it —
 * so a classification on an envelope field is the *same* one `weir sys` already
 * queries, and metadata crossing a zone boundary is visible to the leakage
 * query with no second mechanism.
 *
 * What it adds is the two rules that cannot be defaulted.
 */
export function parseEnvelopeFile(
  yamlText: string,
  name: string,
  resolveField: FieldResolver,
): AnyEdgeDef {
  const envelope = parseEdgeFile(yamlText, name, resolveField);

  for (const [key, fieldDef] of Object.entries(envelope.fields)) {
    // Nested and collection fields are edges, and an edge has no combine rule
    // of its own — merging one would need a rule per leaf, which is a question
    // nothing has asked yet.
    if ("many" in fieldDef || "fields" in fieldDef || "literal" in fieldDef) {
      throw new Error(
        `envelope field "${key}": an envelope carries scalar fields only — a nested or collection field has no combine rule of its own.`,
      );
    }
    const field = fieldDef as FieldDef;

    // **No default**, deliberately (spec §3). Every wrong guess here is silent:
    // `meet` where `same` was meant merges two tokens about different things
    // without complaining, which is precisely the cross-item join the lineage
    // work exists to prevent.
    if (field.combine === undefined) {
      throw new Error(
        `envelope field "${key}": declare "combine" — meet (weakest wins), join (strongest wins), ` +
          `or same (all inputs must agree). There is no default, because guessing wrong here fails silently.`,
      );
    }
    if (field.combine !== "same") {
      if (field.ordinal !== true) {
        throw new Error(
          `envelope field "${key}": "combine: ${field.combine}" needs "ordinal: true" — ` +
            `${field.combine} compares values, and nothing says what order they are in.`,
        );
      }
      if (field.enumValues === undefined || field.enumValues.length === 0) {
        throw new Error(
          `envelope field "${key}": "ordinal: true" orders "enumValues", and this field declares none.`,
        );
      }
    }
  }
  return envelope;
}

/** Resolves a bare edge name (as used by a `.node` file's `input`/`output`) to its declared EdgeDef. */
export type EdgeResolver = (name: string) => AnyEdgeDef;

/**
 * Resolves a `.node` file's `input` value into an `InputSpec`. Handles the
 * shapes `nodeSchema()` (schema.ts) validates today: a bare edge name
 * (`single`) and `{ allOf: [...] }`. `oneOf`/`allOf`/`many` never appear on
 * `input` — those are output-only fan-out shapes (docs/design-history.md,
 * "Fan-out is three different things").
 */
function resolveInputSpec(input: unknown, resolveEdge: EdgeResolver): InputSpec {
  if (typeof input === "string") {
    return { kind: "single", edge: resolveEdge(input) };
  }
  if (input !== null && typeof input === "object" && "allOf" in input) {
    return { kind: "allOf", edges: resolveEdgeNameList(input.allOf, "input.allOf", resolveEdge) };
  }
  if (input !== null && typeof input === "object" && "gather" in input) {
    const ref = (input as { gather: unknown }).gather;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new Error(`"input.gather" must be a bare edge-name reference.`);
    }
    const edge = resolveEdge(ref);
    // The same requirement `output.many` carries, for the same reason: the
    // payload is a collection keyed by each entry's own index, so an edge with
    // no index has no key to be collected under. Checked here rather than left
    // to the membrane so a gather of an index-less edge fails at `weir check`
    // instead of three pulses into a run.
    requireIndex(edge, `"input.gather"`);
    return { kind: "gather", edge };
  }
  throw new Error(`Unrecognized "input" shape: ${JSON.stringify(input)}.`);
}

/**
 * Translates a `.node` file's authoring-form examples into the shapes `Fn`
 * actually receives and returns
 * (docs/superpowers/specs/2026-09-28-examples-reach-the-gate.md).
 *
 * A `.node` file tags examples by edge name — `given: { Recipe: … }` — which is
 * what `nodeSchema()` validates and what `parseAnyOfNodeFile` routes shadows
 * by. A `NodeDef`'s examples are bare: `given` is the payload `Fn` is called
 * with, `expect` is what it returns. Nothing translated between them, so
 * `accept.ts` asserted `{Recipe: …}` against the `Recipe` schema, it failed, and
 * **every example in `examples/` failed its own acceptance gate** while being
 * validated for shape and never run.
 *
 * Translating here rather than at the gate is what keeps `NodeDecl` uniform: a
 * declaration's examples mean one thing regardless of whether it came from YAML
 * or from `defineNode`, so the tagging is an authoring affordance that is gone
 * by the time anything reads a declaration.
 *
 * **The asymmetry is real and is not an inconsistency.** An `allOf` *input* bag
 * is keyed by edge name by design, so its authoring and runtime forms coincide
 * and nothing is stripped. An `allOf` *output* is a list of tagged branches, so
 * they differ — and a `oneOf` output *gains* structure (`{edge, payload}`)
 * rather than losing a wrapper, because the tag carries which branch fired.
 */
function untagExamples(raw: unknown, input: InputSpec, output: OutputSpec): NodeDecl["examples"] {
  if (!Array.isArray(raw)) return raw as NodeDecl["examples"];

  /** The sole value under a one-key tag. Used where the tag only says which edge, which the spec already knows. */
  const sole = (value: unknown, what: string, index: number): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`example ${index}: "${what}" must be tagged by edge name, e.g. "${what}: { EdgeName: … }".`);
    }
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length !== 1) {
      throw new Error(
        `example ${index}: "${what}" must carry exactly one edge-name tag, got ${keys.length === 0 ? "none" : keys.map((k) => `"${k}"`).join(", ")}.`,
      );
    }
    return (value as Record<string, unknown>)[keys[0]!];
  };

  return raw.map((example, index) => {
    const { given, expect } = example as { given?: unknown; expect?: unknown };

    // `allOf` is the one input kind whose authoring form is already the runtime
    // form — the bag is keyed by edge name either way.
    const untaggedGiven = input.kind === "allOf" ? given : sole(given, "given", index);

    let untaggedExpect: unknown;
    if (output.kind === "single" || output.kind === "many") {
      untaggedExpect = sole(expect, "expect", index);
    } else if (output.kind === "oneOf") {
      if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
        throw new Error(`example ${index}: "expect" must name the branch that fired, e.g. "expect: { Branch: … }".`);
      }
      const keys = Object.keys(expect as Record<string, unknown>);
      if (keys.length !== 1) {
        throw new Error(`example ${index}: a oneOf output's "expect" names exactly one branch, got ${keys.length}.`);
      }
      untaggedExpect = { edge: keys[0]!, payload: (expect as Record<string, unknown>)[keys[0]!] };
    } else {
      if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
        throw new Error(`example ${index}: an allOf output's "expect" tags each branch by edge name.`);
      }
      untaggedExpect = Object.entries(expect as Record<string, unknown>).map(([edge, payload]) => ({ edge, payload }));
    }

    return { ...(example as object), given: untaggedGiven, expect: untaggedExpect } as NonNullable<NodeDecl["examples"]>[number];
  });
}

/**
 * Resolves a `.node` file's `output` value into an `OutputSpec` — the four
 * shapes `nodeSchema()` (schema.ts) validates: a bare edge name (`single`),
 * or an `oneOf`/`allOf`/`many` tagged object (docs/design-history.md,
 * "Fan-out is three different things").
 */
function resolveOutputSpec(output: unknown, resolveEdge: EdgeResolver): OutputSpec {
  if (typeof output === "string") {
    return { kind: "single", edge: resolveEdge(output) };
  }
  if (output !== null && typeof output === "object") {
    if ("oneOf" in output) {
      return { kind: "oneOf", edges: resolveEdgeNameList(output.oneOf, "output.oneOf", resolveEdge) };
    }
    if ("allOf" in output) {
      return { kind: "allOf", edges: resolveEdgeNameList(output.allOf, "output.allOf", resolveEdge) };
    }
    if ("many" in output) {
      const ref = (output as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"output.many" must be a bare edge-name reference.`);
      }
      const edge = resolveEdge(ref);
      requireIndex(edge, `"output.many"`);
      return { kind: "many", edge };
    }
  }
  throw new Error(`Unrecognized "output" shape: ${JSON.stringify(output)}.`);
}

function resolveEdgeNameList(names: unknown, path: string, resolveEdge: EdgeResolver): AnyEdgeDef[] {
  if (!Array.isArray(names)) {
    throw new Error(`"${path}" must be a list of edge names.`);
  }
  return names.map((n) => resolveEdge(n as string));
}

/** Parse a `.node` file's YAML text (and its filename-derived name) into a validated NodeDecl. */
export function parseNodeFile(yamlText: string, name: string, resolveEdge: EdgeResolver): NodeDecl {
  return parseNodeDecl(parse(yamlText) as Record<string, unknown>, name, resolveEdge);
}

/**
 * The body of `parseNodeFile`, taking an already-parsed object.
 *
 * Split out so an instantiated row (`for:`, below) goes through **the same**
 * parser and the same schema check as a hand-written node, rather than a second
 * path that would drift. A row is a node; nothing about it should be checked
 * more loosely.
 */
function parseNodeDecl(raw: Record<string, unknown>, name: string, resolveEdge: EdgeResolver): NodeDecl {
  // Ahead of the schema, for the same reason as `.field`/`.edge`: "unknown
  // key" is true but does not say why the key cannot exist.
  if ("name" in raw) {
    throw new Error(`.node files don't declare "name" — the filename is the name.`);
  }
  if ("fn" in raw) {
    throw new Error(`.node files don't declare "fn" — an implementation is resolved by contract hash, never inlined (docs/design.md §10).`);
  }
  assertDeclaration("node", raw);
  if ("name" in raw) {
    throw new Error(`.node files don't declare "name" — the filename is the name.`);
  }
  if ("fn" in raw) {
    throw new Error(`.node files declare the contract only (docs/design.md §10) — "fn" belongs in the implementation tree, not here.`);
  }
  const { label, description, input, output, examples, closure, properties, effect, contributes, scope } = raw as {
    label?: unknown;
    description?: unknown;
    input?: unknown;
    output?: unknown;
    examples?: unknown;
    effect?: unknown;
    closure?: unknown;
    properties?: unknown;
    contributes?: unknown;
    scope?: unknown;
  };

  const inputSpec = resolveInputSpec(input, resolveEdge);
  const outputSpec = resolveOutputSpec(output, resolveEdge);
  return {
    name,
    ...(typeof label === "string" && { label }),
    ...(typeof description === "string" && { description }),
    input: inputSpec,
    output: outputSpec,
    ...(examples !== undefined && { examples: untagExamples(examples, inputSpec, outputSpec) }),
    ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),
    ...(contributes !== undefined && { contributes: contributes as NodeDecl["contributes"] }),
    ...(Array.isArray(scope) && { scope: scope as string[] }),
    ...(properties !== undefined && { properties: properties as NodeDecl["properties"] }),
    ...(typeof effect === "string" && { effect }),
  };
}

/** Matches a whole-string `$name` substitution in a `for:` template. */
const SUBSTITUTION = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Substitutes a `for:` row's values into a template, recursively.
 *
 * **Whole-string only.** `$edge` is a substitution; `prefix$edge` is the literal
 * string `prefix$edge`. Interpolation would make the grammar ambiguous the
 * moment an author wants a literal `$`, and nothing in the motivating use case
 * needs it — a row supplies an edge name, a field name, a separator, each of
 * which is a whole value.
 */
function substitute(value: unknown, row: Record<string, unknown>, where: string): unknown {
  if (typeof value === "string") {
    const match = SUBSTITUTION.exec(value);
    if (match === null) return value;
    const key = match[1]!;
    if (!(key in row)) {
      throw new Error(
        `${where}: "$${key}" is not a column of this row — the row declares ${Object.keys(row).join(", ") || "(nothing)"}.`,
      );
    }
    return row[key];
  }
  if (Array.isArray(value)) return value.map((entry, i) => substitute(entry, row, `${where}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, row, `${where}.${k}`)]),
    );
  }
  return value;
}

/**
 * Parses a `.node` file declaring `for:` into N separate `NodeDecl`s, one per
 * row (docs/superpowers/specs/2026-09-29-instantiation.md §3).
 *
 * **The table is the point, not the syntax.** 83 near-identical files assert
 * that 83 different things exist; one table with 83 rows asserts that one thing
 * exists in 83 configurations, which is the true claim — and it is reviewable as
 * a unit. `design-history.md`'s "Generics: elaboration monomorphizes" named this
 * exact failure as its own second cost: *"if the elaborator isn't pleasant to
 * use, the forty declarations get hand-written instead."*
 *
 * Named `<template>_<key>`, single underscore — deliberately unlike
 * `parseAnyOfNodeFile`'s `__`, which needs two because it joins an *edge* name
 * that may already contain one. A row key is author-chosen, and the convention
 * this replaces is `expect_Person_age_42`, a hand-written monomorphization with
 * single underscores.
 *
 * Each row goes through `parseNodeDecl` — the same parser and the same schema
 * check a hand-written node gets — after substitution, so nothing about a row is
 * checked more loosely than the file it replaces.
 */
function parseInstantiatedNodeFile(
  yamlText: string,
  name: string,
  resolveEdge: EdgeResolver,
): Record<string, NodeDecl> {
  const raw = parse(yamlText) as Record<string, unknown>;
  const { for: rows, ...template } = raw as { for?: unknown } & Record<string, unknown>;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`"for" must be a non-empty list of rows, each declaring a "key".`);
  }
  // Examples cannot live on the template: `given` is tagged by edge name, and
  // the edge is exactly what varies per row, so a shared example would be wrong
  // for every row but one (spec §4).
  if ("examples" in template) {
    throw new Error(
      `a "for" template declares no "examples" — they belong on each row, because an example names ` +
        `concrete edges and values and those are what a row varies. Move them under the row.`,
    );
  }

  const declarations: Record<string, NodeDecl> = {};
  const seen = new Set<string>();
  for (const [index, entry] of rows.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`for[${index}] must be a row object.`);
    }
    const row = entry as Record<string, unknown>;
    const key = row.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`for[${index}] declares no "key" — a row's key names the node it elaborates to.`);
    }
    // Two rows with one key would collide into a single node, silently keeping
    // whichever was parsed last.
    if (seen.has(key)) throw new Error(`for[${index}]: duplicate key "${key}" — each row names a distinct node.`);
    seen.add(key);

    const { key: _key, examples, ...vars } = row;
    const instantiated = {
      ...(substitute(template, vars, `for[${index}]`) as Record<string, unknown>),
      ...(examples !== undefined && { examples }),
    };
    const instanceName = `${name}_${key}`;
    declarations[instanceName] = inFile(`${name}.node (for[${index}], key "${key}")`, () =>
      parseNodeDecl(instantiated, instanceName, resolveEdge),
    );
  }
  return declarations;
}

/**
 * Parses a `.node` file whose `input` is `{ anyOf: [...] }` into N separate
 * `NodeDecl`s, one per listed edge — desugaring sugar, not a real
 * `InputSpec` kind (docs/superpowers/specs/2026-08-31-any-desugaring-design.md,
 * docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md). Named
 * `<name>__<edgeName>`, double underscore (edge names can already contain
 * single underscores, e.g. `Failed_Todo_TodoList`, so a single underscore
 * join would be ambiguous to a human reading the name).
 *
 * Each example in the original file's `examples` array is routed to the one
 * shadow whose edge name appears as its `given`'s tag key (schema.ts's
 * `taggedOne` already guarantees exactly one tag per example at the
 * authoring level). A shadow with no matching examples gets no `examples`
 * key at all — the same "examples optional" looseness `parseNodeFile`
 * already has, not a new gap this introduces.
 */
function parseAnyOfNodeFile(
  yamlText: string,
  name: string,
  resolveEdge: EdgeResolver,
): Record<string, NodeDecl> {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.node files don't declare "name" — the filename is the name.`);
  }
  if ("fn" in raw) {
    throw new Error(`.node files declare the contract only (docs/design.md §10) — "fn" belongs in the implementation tree, not here.`);
  }
  const { label, description, input, output, examples, closure, properties } = raw as {
    label?: unknown;
    description?: unknown;
    input?: { anyOf: unknown };
    output?: unknown;
    examples?: unknown;
    closure?: unknown;
    properties?: unknown;
  };

  const edges = resolveEdgeNameList(input?.anyOf, "input.anyOf", resolveEdge);
  const outputSpec = resolveOutputSpec(output, resolveEdge);
  const allExamples = (examples as { given: Record<string, unknown>; expect: unknown }[] | undefined) ?? [];

  const decls: Record<string, NodeDecl> = {};
  for (const edge of edges) {
    const shadowName = `${name}__${edge.name}`;
    const shadowExamples = allExamples.filter((example) => edge.name in example.given);
    decls[shadowName] = {
      name: shadowName,
      ...(typeof label === "string" && { label }),
      ...(typeof description === "string" && { description }),
      input: { kind: "single", edge },
      output: outputSpec,
      ...(shadowExamples.length > 0 && { examples: shadowExamples as NodeDecl["examples"] }),
      ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),
      ...(properties !== undefined && { properties: properties as NodeDecl["properties"] }),
    };
  }
  return decls;
}

/** Wiring — what a `.topology` file describes (docs/open-questions.md, ".topology authoring format"). */
export interface Wiring {
  /** Node names with nothing feeding them within the loaded topology — top-level keys. */
  origins: string[];
  /** node name -> the node names it feeds, deduplicated across however many parents mention it. */
  feeds: Record<string, string[]>;
}

/**
 * Resolves a bare node name (as used by a `.topology` file) to the real
 * underlying node name(s) it refers to. Throws if unresolvable. `[name]` for
 * an ordinary node; all shadow names for a anyOf-desugared original.
 */
export type NodeNameResolver = (name: string) => string[];

/**
 * Parses a `.topology` file's nested `then:` map into a `Wiring`
 * (docs/open-questions.md, ".topology authoring format"): a node name is a
 * key; `then:` maps to the node names it feeds; fan-out is several keys
 * under one `then:`; a node fed by more than one parent needs no special
 * join syntax — it just appears again under each parent's own `then:`.
 * Several top-level keys are independent origins, resolving the
 * previously-open "how do multiple roots sit in one file" question the
 * obvious way the sketch already implied.
 *
 * No cycle detection: a repeated name (`birthday.then.birthday`) is a
 * legitimate distinct application, not a cycle (docs/design-history.md,
 * "Weir has no loop construct") — the YAML itself is always a finite tree,
 * so nothing can actually recurse forever. A name that resolves to more
 * than one real node (a anyOf-desugared original) expands to references to
 * all of them, uniformly, whether it appears as a parent or a child —
 * deliberately imprecise rather than smart, since a wasted readiness check
 * on the wrong shadow is free (docs/superpowers/specs/2026-08-31-any-desugaring-design.md).
 */
/**
 * A `.topology` file that declares a contract: a named, contracted topology
 * another topology may reference exactly where it would reference a node
 * (docs/superpowers/specs/2026-09-26-composite-nodes.md). A file is a
 * composite exactly when it declares `input:` at the top level.
 *
 * A root declares the rest of the same contract — `output` and `terminals`,
 * but no `input`, because a root's input is the trigger and that has its own
 * unresolved plumbing (2026-09-28-a-root-topology-declares-its-end.md §5). So
 * every `.topology` now declares a contract, and the only difference between a
 * root and a composite is whether its beginning is declared too.
 *
 * `input`, `output`, `terminals` and `wiring` are reserved at the top level of
 * a `.topology`, so a node may not be named any of them.
 */
export interface CompositeDecl {
  name: string;
  input: InputSpec;
  output: OutputSpec;
  /** The inner nodes whose outputs are this composite's output. */
  terminals: string[];
  wiring: Wiring;
  /**
   * Where this topology runs — `design.md` §7's zone, declared once for the
   * subgraph rather than repeated on every node in it
   * (docs/superpowers/specs/2026-09-28-zones-are-a-line-in-the-topology.md).
   *
   * **Optional**, unlike `input`/`output`/`terminals`: most programs have no
   * placement concern, and an unzoned topology's nodes are *unzoned* rather than
   * in a default zone. That distinction is load-bearing at the boundary — an
   * edge between an unzoned node and a zoned one is not a crossing, because
   * nothing was claimed about where the first one runs, and inventing a default
   * would manufacture crossings nobody declared.
   */
  zone?: string;
  /**
   * What this topology claims its composition does, in the same
   * `given`/`expect` form a node declares
   * (docs/superpowers/specs/2026-09-28-a-topology-can-be-tested.md).
   * Translated out of its authoring tagging by `untagExamples`, which needed no
   * extension: it takes an `InputSpec` and an `OutputSpec`, and a topology has
   * both.
   */
  examples?: NodeDecl["examples"];
}

/**
 * What a root `.topology` declares about finishing
 * (docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md).
 *
 * Deliberately the same pair a composite declares, meaning the same things,
 * because the alternative — naming terminal *edges* alone — is a false green
 * for any topology whose nodes are rhombus-shaped. `examples/todo-list` has two
 * different nodes producing `TodoList`, so "a TodoList exists" is satisfied by
 * an intermediate one three pulses before the run finished. Naming the
 * producing **node** is what makes the question instance-level, and it is why
 * composites declare terminals rather than inferring them.
 */
export interface RootEnd {
  /** The topology file's name, for the error message. */
  name: string;
  /** What the run must produce to have finished. An ordinary OutputSpec — every mode is used across the examples. */
  output: OutputSpec;
  /** The nodes whose outputs count as that output. Not inferrable: a cyclic topology (`escalation`) has no structural leaf at all. */
  terminals: string[];
}

/** Top-level keys a `.topology` reserves for its contract. */
export const TOPOLOGY_RESERVED_KEYS = ["input", "output", "terminals", "wiring", "examples", "zone"] as const;

/** Whether a parsed `.topology` document declares a contract rather than being bare wiring. */
export function isCompositeTopology(yamlText: string): boolean {
  const raw = (parse(yamlText) as Record<string, unknown> | null) ?? {};
  return "input" in raw;
}

/**
 * Parses any `.topology` into a `CompositeDecl`. Its filename is its name.
 *
 * There is one parser because there is one shape
 * (docs/superpowers/specs/2026-09-28-a-topology-declares-its-beginning.md §1).
 * A topology used to be a *root* or a *composite* depending on whether it
 * declared `input:`; now every topology declares one, so that test would
 * distinguish nothing. What distinguishes them is whether another topology
 * **references** them — which was always the real difference, and is derivable
 * rather than declared. A root was never a different kind of thing; it was a
 * composite nobody had referenced yet.
 */
export function parseCompositeTopologyFile(
  yamlText: string,
  name: string,
  resolveEdge: EdgeResolver,
  resolveNodeName: NodeNameResolver,
): CompositeDecl {
  const raw = (parse(yamlText) as Record<string, unknown> | null) ?? {};
  // `.topology` was the one declaration kind never validated against its own
  // schema — `assertDeclaration` was wired for field, edge and node when "make
  // `weir check` actually check" closed that gap, and topologies were missed.
  // The hand-written parsing below catches an unrecognized *key*; only the
  // schema catches a malformed *value*.
  assertDeclaration("topology", raw);
  const { input, output, terminals, wiring, examples, zone, ...rest } = raw as {
    input?: unknown;
    output?: unknown;
    terminals?: unknown;
    wiring?: unknown;
    examples?: unknown;
    zone?: unknown;
  };
  const unrecognized = Object.keys(rest)[0];
  if (unrecognized !== undefined) {
    throw new Error(
      `Composite topology "${name}": unrecognized top-level key "${unrecognized}" — a composite declares only ${TOPOLOGY_RESERVED_KEYS.join(", ")}.`,
    );
  }
  if (input === undefined) {
    throw new Error(
      `Topology "${name}": declares no "input" — a topology must say what its trigger supplies, so one external event can populate every origin it declares needing (design.md §5).`,
    );
  }
  if (output === undefined) {
    throw new Error(`Topology "${name}": declares "input" but no "output".`);
  }
  if (!Array.isArray(terminals) || terminals.length === 0) {
    throw new Error(
      `Topology "${name}": needs a non-empty "terminals" list — the nodes whose outputs are this topology's output. Not inferrable from the wiring: a cyclic topology has no leaf.`,
    );
  }
  if (wiring === undefined) {
    throw new Error(`Topology "${name}": declares a contract but no "wiring".`);
  }
  const inputSpec = resolveInputSpec(input, resolveEdge);
  const outputSpec = resolveOutputSpec(output, resolveEdge);
  return {
    name,
    input: inputSpec,
    output: outputSpec,
    terminals: terminals.map(String),
    wiring: parseWiringObject(wiring as Record<string, unknown>, resolveNodeName),
    ...(typeof zone === "string" && { zone }),
    ...(examples !== undefined && { examples: untagExamples(examples, inputSpec, outputSpec) }),
  };
}

/** Bare wiring, with no contract around it — a composite's `wiring:` value, and what tests parse directly. */
export function parseTopologyFile(yamlText: string, resolveNodeName: NodeNameResolver): Wiring {
  return parseWiringObject((parse(yamlText) as Record<string, unknown> | null) ?? {}, resolveNodeName);
}

/**
 * The wiring walk itself, over an already-parsed object. Shared by a bare
 * `.topology` (whose whole document is the wiring) and a composite's
 * `wiring:` key, so both get identical semantics rather than two parsers
 * that could drift.
 */
function parseWiringObject(raw: Record<string, unknown>, resolveNodeName: NodeNameResolver): Wiring {
  const origins: string[] = [];
  const feeds = new Map<string, Set<string>>();

  function walk(name: string, value: unknown): void {
    resolveNodeName(name);
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`"${name}": expected an object (optionally with "then"), got ${typeof value}.`);
    }
    const { then, ...rest } = value as { then?: unknown };
    const unrecognized = Object.keys(rest)[0];
    if (unrecognized !== undefined) {
      throw new Error(`"${name}": only "then" is a recognized key, got "${unrecognized}".`);
    }
    if (then === undefined) return;
    if (then === null || typeof then !== "object" || Array.isArray(then)) {
      throw new Error(`"${name}.then" must be a map of node names.`);
    }
    for (const [childName, childValue] of Object.entries(then)) {
      for (const parent of resolveNodeName(name)) {
        if (!feeds.has(parent)) feeds.set(parent, new Set());
        for (const child of resolveNodeName(childName)) feeds.get(parent)!.add(child);
      }
      walk(childName, childValue);
    }
  }

  for (const [name, value] of Object.entries(raw)) {
    origins.push(...resolveNodeName(name));
    walk(name, value);
  }

  return {
    origins,
    feeds: Object.fromEntries([...feeds.entries()].map(([k, v]) => [k, [...v]])),
  };
}

/** Merges two `Wiring`s — natural, if untested by any current fixture, for multiple `.topology` files in one root. */
function mergeWiring(a: Wiring, b: Wiring): Wiring {
  const feeds = new Map<string, Set<string>>();
  for (const [source, targets] of [...Object.entries(a.feeds), ...Object.entries(b.feeds)]) {
    if (!feeds.has(source)) feeds.set(source, new Set());
    for (const target of targets) feeds.get(source)!.add(target);
  }
  return {
    origins: [...a.origins, ...b.origins],
    feeds: Object.fromEntries([...feeds.entries()].map(([k, v]) => [k, [...v]])),
  };
}

/**
 * What a node's declared output can actually put on the wire. Every kind
 * contributes its edges at single multiplicity: `oneOf`/`allOf` because the
 * runtime logs one instance per tagged branch, and `many` because spread
 * materializes a collection's entries as real instances of the declared edge
 * (`runtime.ts`'s `logOutput`, 2026-09-26-spread-materializes-elements.md).
 *
 * This comment used to claim `many` was returned "flagged `many`", and Rule A
 * used to reject a `many X` output wired into a `single X` input on the
 * strength of it. Spread made that wiring correct — it is how per-element
 * work happens — so the flag and the rule went, and the comment describing
 * them outlived both by a day. Corrected while building `gather`.
 */
function producedEdges(node: NodeDecl): { name: string }[] {
  const output = node.output;
  const declared =
    output.kind === "single" || output.kind === "many"
      ? [{ name: output.edge.name }]
      : output.edges.map((edge) => ({ name: edge.name }));

  // Every node can also emit `Failed<In>`, which the runtime logs under a
  // synthesized edge named for the node's *input* (`runtime.ts`'s
  // `failedEdgeName`/`failedAllOfEdgeName`). It never appears in an
  // `output:` declaration, but it is genuinely on the wire, and a topology
  // is allowed to route it — `examples/person-birthday` wires an
  // anyOf-desugared handler to exactly these edges. Omitting it here made
  // the arc rule reject that legitimate wiring.
  const failed =
    node.input.kind === "single"
      ? failedEdgeName(node.input.edge.name)
      : node.input.kind === "gather"
        ? // Not `Failed_<X>`: a gather's failure carries the *collection* it
          // was holding, a different shape from one `X`, so it routes under
          // its own synthesized edge (see `failedGatherEdgeName`).
          failedGatherEdgeName(node.input.edge.name)
        : failedAllOfEdgeName(node.input.edges);

  return [...declared, { name: failed }];
}

/**
 * The edge names a node declares needing — `inputEdgeNames` (types.ts), aliased
 * locally because the wiring rules below read better saying *consumed*. A gather
 * adds no case to either rule beyond Rule C, its own, because its candidates
 * arrive one at a time on one arc like any single input's.
 */
const consumedEdges = inputEdgeNames;

/**
 * Elaboration-time wiring checks — the "will not compile" gate for a
 * topology whose arcs don't typecheck against the contracts they connect.
 * Three rules:
 *
 * **A, arc soundness.** Every arc must carry at least one edge the consumer
 * declares. The motivating failure was a `many X` output wired into a
 * `single X` input — before `spread`, no input was ever `many`, so nothing on
 * that arc could satisfy the consumer, and the program elaborated clean, ran
 * to `quiescence` with `failures: []`, and surfaced as a schema error two
 * nodes downstream complaining that `X` was missing fields it never had.
 * Spread made that wiring legitimate (it materializes the entries as real
 * `X` instances), so what is left of A is the plainer miswiring: an arc whose
 * two sides name no edge in common, reported so the message can say what each
 * side actually declares.
 *
 * **B, node reachability.** The union of a node's parents must cover every
 * edge it declares needing, so a node that can never become ready is
 * rejected rather than silently never firing. Origins are exempt: their
 * input arrives as an `originPayload`, not along an arc (`runtime.ts`'s
 * `Run.originPayloads`), so they have no parents by construction. A node
 * that is neither an origin nor fed by anything is *not* exempt — it can
 * never fire, which is exactly what this rule is for.
 *
 * A self-loop satisfies B through itself, which is correct: a node wired
 * back to its own input genuinely does supply it (`countToThree`'s shape,
 * docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md).
 *
 * **C, a gather has a spread above it.** A `gather: X` node fires on a
 * barrier — the collection token a `many` output logged — so a gather with no
 * spread anywhere upstream has no count to fire on and simply never fires.
 * B does not catch it: something does produce `X`, so the node looks ready.
 * Checked here because it is the one thing about a gather that is decidable
 * from the topology, and because the alternative is the failure mode this
 * repo rates worst — a run that reaches quiescence having silently skipped a
 * node, with `weir check` reporting ✓.
 */
function assertWiringTypes(
  nodes: Record<string, NodeDecl>,
  wiring: Wiring,
  anyOfAliases: Map<string, string[]>,
): void {
  // One authored topology mention of an `anyOf` node expands into N shadow
  // nodes, one per declared input edge — so the elaborator writes N arcs
  // where the author wrote one. Only the shadow whose edge actually shows up
  // can ever fire; that is what `anyOf` means. Both rules below therefore
  // ask their question of the *group*, not of each shadow separately:
  // holding an author to a per-arc rule on arcs they never wrote would
  // reject every legitimate `anyOf` wiring.
  const siblingsOf = new Map<string, string[]>();
  for (const shadows of anyOfAliases.values()) {
    for (const shadow of shadows) siblingsOf.set(shadow, shadows);
  }
  const groupOf = (name: string): string[] => siblingsOf.get(name) ?? [name];

  const parentsOf = new Map<string, string[]>();
  for (const [parent, children] of Object.entries(wiring.feeds)) {
    for (const child of children) {
      if (!parentsOf.has(child)) parentsOf.set(child, []);
      parentsOf.get(child)!.push(parent);
    }
  }

  // Rule A, per arc.
  for (const [parent, children] of Object.entries(wiring.feeds)) {
    const produced = producedEdges(nodes[parent]!);
    for (const child of children) {
      const group = groupOf(child);
      const satisfiable = group.some((sibling) => {
        const consumed = new Set(consumedEdges(nodes[sibling]!.input));
        return produced.some((p) => consumed.has(p.name));
      });
      if (satisfiable) continue;

      const consumed = new Set(group.flatMap((sibling) => consumedEdges(nodes[sibling]!.input)));
      throw new Error(
        `Wiring: the arc "${parent}" -> "${child}" carries nothing "${child}" can use — "${parent}" produces ${produced.map((p) => `"${p.name}"`).join(", ")}; "${child}" consumes ${[...consumed].map((name) => `"${name}"`).join(", ")}.`,
      );
    }
  }

  // Rule B, per node. Only nodes the topology actually mentions are in
  // scope: "can this node become ready" is a question about a wiring, and a
  // declared-but-unwired node isn't in one. Without this, every fixture that
  // exercises `.node` parsing with no `.topology` file at all would be
  // rejected for having no parents — and whether an unreferenced declaration
  // is itself an error is a separate question this check doesn't answer.
  const origins = new Set(wiring.origins);
  const wired = new Set([...origins, ...Object.keys(wiring.feeds), ...Object.values(wiring.feeds).flat()]);
  for (const name of Object.keys(nodes)) {
    if (origins.has(name) || !wired.has(name)) continue;
    const parents = parentsOf.get(name) ?? [];
    const covered = new Set(
      parents.flatMap((parent) => producedEdges(nodes[parent]!).map((p) => p.name)),
    );
    const missing = consumedEdges(nodes[name]!.input).filter((edge) => !covered.has(edge));
    if (missing.length === 0) continue;
    // A shadow that can never become ready is fine as long as one of its
    // siblings can — the group, not the shadow, is what the author wired.
    const group = groupOf(name);
    if (group.length > 1) {
      const anySiblingReady = group.some((sibling) => {
        const siblingCovered = new Set(
          (parentsOf.get(sibling) ?? []).flatMap((parent) => producedEdges(nodes[parent]!).map((p) => p.name)),
        );
        return consumedEdges(nodes[sibling]!.input).every((edge) => siblingCovered.has(edge));
      });
      if (anySiblingReady) continue;
    }
    throw new Error(
      `Wiring: "${name}" declares needing ${missing.map((edge) => `"${edge}"`).join(", ")}, but nothing wired into it produces ${missing.length === 1 ? "it" : "them"} — its parents are ${parents.length === 0 ? "none" : parents.map((p) => `"${p}"`).join(", ")}.`,
    );
  }

  // Rule C, per gather node.
  for (const [name, node] of Object.entries(nodes)) {
    if (node.input.kind !== "gather" || !wired.has(name)) continue;
    const seen = new Set<string>([name]);
    const frontier = [...(parentsOf.get(name) ?? [])];
    let spread: string | undefined;
    while (frontier.length > 0 && spread === undefined) {
      const ancestor = frontier.pop()!;
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      if (nodes[ancestor]?.output.kind === "many") spread = ancestor;
      else frontier.push(...(parentsOf.get(ancestor) ?? []));
    }
    if (spread !== undefined) continue;
    throw new Error(
      `Wiring: "${name}" gathers "${(node.input as { edge: AnyEdgeDef }).edge.name}", but nothing upstream of it declares a "many" output — a gather's barrier is the collection a spread produced, so with no spread above it there is no count to fire on and it would never fire.`,
    );
  }
}

/**
 * Replaces every composite reference in `wiring` with the composite's own
 * nodes, wired in at both ends — the whole of composite-node support
 * (docs/superpowers/specs/2026-09-26-composite-nodes.md §4). The runtime
 * never learns composites exist.
 *
 * Inlining rather than a runtime membrane is deliberate, and the reasoning
 * is worth having here rather than only in the spec: what the boundary was
 * *for* is authoring. A `.topology` file is geometrically a tree and cannot
 * express reconvergence, so joins had to move to a boundary; inlining keeps
 * every authored file a tree and lets the elaborator assemble the DAG, which
 * is already its job. What it costs is recursive composition — a composite
 * cannot reference itself — which is rejected below rather than looped on.
 *
 * Two references to one composite become two independent node sets, which is
 * not a compromise but the rule positional identity asks for (two mentions
 * are two instances) arriving for free.
 */
function inlineComposites(
  nodes: Record<string, NodeDecl>,
  wiring: Wiring,
  composites: Map<string, CompositeDecl>,
  stack: string[] = [],
  prefix = "",
): Wiring {
  const referenced = new Set(
    [...wiring.origins, ...Object.keys(wiring.feeds), ...Object.values(wiring.feeds).flat()].filter((n) =>
      composites.has(n),
    ),
  );
  if (referenced.size === 0) return wiring;

  let origins = [...wiring.origins];
  const feeds = new Map<string, string[]>(Object.entries(wiring.feeds).map(([k, v]) => [k, [...v]]));

  for (const name of referenced) {
    if (stack.includes(name)) {
      throw new Error(
        `Composite topology "${name}" references itself (${[...stack, name].join(" -> ")}) — recursive composition is not supported; a composite is inlined at elaboration, so it must nest finitely.`,
      );
    }
    const composite = composites.get(name)!;

    // One reference site per parent that feeds it, plus one if it is an
    // origin. More than one site means the composite is instantiated more
    // than once, and each instance needs its own node names.
    const parents = [...feeds.entries()].filter(([, kids]) => kids.includes(name)).map(([p]) => p);
    const sites: (string | null)[] = [...(origins.includes(name) ? [null] : []), ...parents];
    const qualify = (siteIndex: number): string =>
      sites.length > 1 ? `${prefix}${name}#${siteIndex + 1}` : `${prefix}${name}`;

    sites.forEach((parent, siteIndex) => {
      const instance = qualify(siteIndex);
      // Expand the composite's own wiring first, so a composite containing a
      // composite flattens bottom-up under this instance's prefix.
      const inner = inlineComposites(nodes, composite.wiring, composites, [...stack, name], `${instance}/`);

      const rename = (innerName: string): string =>
        composites.has(innerName) ? innerName : `${instance}/${innerName}`;

      for (const innerName of new Set([...inner.origins, ...Object.keys(inner.feeds), ...Object.values(inner.feeds).flat()])) {
        const decl = nodes[innerName];
        if (decl !== undefined && nodes[rename(innerName)] === undefined) {
          // The *key* is qualified; `name` deliberately is not. An inlined
          // copy is the same node in a different position — same contract,
          // same hash, same accepted implementation. `fingerprintNode`
          // includes `name` and `implementation.ts` resolves
          // `{node.name}/<hash>.ts`, so renaming here would silently orphan
          // every composite's implementations.
          nodes[rename(innerName)] = { ...decl };
        }
      }
      for (const [innerParent, innerKids] of Object.entries(inner.feeds)) {
        const key = rename(innerParent);
        feeds.set(key, [...new Set([...(feeds.get(key) ?? []), ...innerKids.map(rename)])]);
      }

      const entries = inner.origins.map(rename);
      const exits = composite.terminals.map(rename);

      if (parent === null) {
        origins = [...origins.filter((o) => o !== name), ...entries];
      } else {
        feeds.set(parent, [...new Set([...feeds.get(parent)!.filter((k) => k !== name), ...entries])]);
      }
      for (const exit of exits) {
        feeds.set(exit, [...new Set([...(feeds.get(exit) ?? []), ...(wiring.feeds[name] ?? [])])]);
      }
    });

    feeds.delete(name);
    origins = origins.filter((o) => o !== name);
  }

  return { origins, feeds: Object.fromEntries(feeds) };
}

/**
 * A composite's declared `output` must be what its terminals actually
 * produce. Rule B at the boundary rather than a new rule: the same question
 * `assertWiringTypes` asks of a node's parents, asked of a composite's exits.
 */
/**
 * One entry per distinct node *contract*, keyed by the node's own name.
 *
 * `inlineComposites` deliberately leaves a composite's inner nodes under two
 * keys — the bare `fetchDirect` and the qualified `directCountyFetch/fetchDirect`
 * — so that a wiring can name either. Every caller that asks "what nodes does
 * this program have?" rather than "what does this wiring point at?" wants the
 * contracts, not the placements, and gets duplicates if it reads the map
 * directly. That produced combinatorially many equivalent routes in `plan` and
 * double-reported examples in `test`.
 *
 * The unqualified key wins; an inlined instance only fills a gap, which is what
 * keeps the answer stable regardless of map order.
 */
export function distinctContracts<T extends { name: string }>(nodes: Record<string, T>): Record<string, T> {
  const byName: Record<string, T> = {};
  for (const [key, decl] of Object.entries(nodes)) {
    if (key === decl.name || !(decl.name in byName)) byName[decl.name] = decl;
  }
  return byName;
}

/** The edge names an OutputSpec names, whatever its mode. */
export function outputEdgeNames(output: OutputSpec): string[] {
  return output.kind === "single" || output.kind === "many"
    ? [output.edge.name]
    : output.edges.map((edge) => edge.name);
}

/**
 * Every contracted topology's terminals must actually be able to produce what
 * it declares — the static half of both a composite's contract and a root's
 * end (2026-09-28-a-root-topology-declares-its-end.md §2).
 *
 * One routine for both, taking the pair rather than either declaration type,
 * because the check is identical and a second copy would be a second place for
 * it to drift. A root is a composite that declares no beginning; nothing about
 * *this* question distinguishes them.
 */
function assertTopologyContracts(
  nodes: Record<string, NodeDecl>,
  contracts: { kind: string; name: string; output: OutputSpec; terminals: string[] }[],
): void {
  for (const contract of contracts) {
    const produced = new Set(
      contract.terminals.flatMap((terminal) => {
        const decl = nodes[terminal];
        if (decl === undefined) {
          throw new Error(`${contract.kind} "${contract.name}": terminal "${terminal}" is not a declared node.`);
        }
        return producedEdges(decl).map((p) => p.name);
      }),
    );
    const missing = outputEdgeNames(contract.output).filter((name) => !produced.has(name));
    if (missing.length > 0) {
      throw new Error(
        `${contract.kind} "${contract.name}": declares output ${missing.map((m) => `"${m}"`).join(", ")}, but its terminals (${contract.terminals.join(", ")}) produce ${[...produced].map((p) => `"${p}"`).join(", ")}.`,
      );
    }
  }
}

/**
 * Rewrites a declared terminal into the node keys that actually exist after
 * elaboration, so an author names the unit they wired rather than its insides.
 * Two rewrites, both for names the author legitimately wrote and the elaborator
 * legitimately replaced:
 *
 * - **A composite** becomes the inlined keys producing its output — `split`
 *   becomes `split/toLeft`, `split/toRight`, or `split#1/…` and `split#2/…`
 *   when referenced twice. Deliberately done after inlining, because only then
 *   is the instance count known.
 * - **An `anyOf` node** becomes its desugared shadows (`HandleFailed` becomes
 *   `HandleFailed__Failed_Todo`, `HandleFailed__Failed_Person`), the same
 *   expansion `resolveNodeName` already applies to the wiring. Exactly one
 *   shadow fires, which is what `anyOf` means — so this end behaves like a
 *   `oneOf`, and requiring *every* shadow to have produced would be the
 *   "every terminal must fire" rule the spec rejects.
 *
 * Unresolvable names pass through unchanged so `assertTopologyContracts`
 * reports them, rather than this function silently dropping a typo into an
 * empty list and making the contract vacuous.
 */
function expandTerminals(
  terminals: string[],
  composites: Map<string, CompositeDecl>,
  nodes: Record<string, NodeDecl>,
  anyOfAliases: Map<string, string[]>,
): string[] {
  return terminals.flatMap((terminal) => {
    const shadows = anyOfAliases.get(terminal);
    if (shadows !== undefined) return shadows;
    const composite = composites.get(terminal);
    if (composite === undefined) return [terminal];
    const inner = new Set(composite.terminals);
    const found = Object.keys(nodes).filter((key) => {
      const slash = key.indexOf("/");
      if (slash === -1) return false;
      const instance = key.slice(0, slash);
      return (instance === terminal || instance.startsWith(`${terminal}#`)) && inner.has(key.slice(slash + 1));
    });
    return found.length > 0 ? found : [terminal];
  });
}

/**
 * The trigger must cover the origins, and the origins must cover the trigger
 * (docs/superpowers/specs/2026-09-28-a-topology-declares-its-beginning.md §4).
 *
 * Both directions, because each catches a different mistake. An origin whose
 * input edge the trigger does not supply can never fire — the same silent
 * never-fires Rules A and B already reject for arcs and coverage. And an edge
 * the entry declares that no origin consumes is a promise the program does not
 * keep, which is exactly what a renamed origin leaves behind.
 */
function assertTriggerCoverage(
  nodes: Record<string, NodeDecl>,
  wiring: Wiring,
  entries: CompositeDecl[],
): void {
  if (entries.length === 0) return;
  const supplied = new Set(entries.flatMap((entry) => inputEdgeNames(entry.input)));
  const wanted = new Map<string, string[]>();
  for (const origin of wiring.origins) {
    const decl = nodes[origin];
    if (decl === undefined) continue; // reported by the wiring scan, not here
    for (const edge of inputEdgeNames(decl.input)) {
      wanted.set(edge, [...(wanted.get(edge) ?? []), origin]);
    }
  }

  for (const [edge, origins] of wanted) {
    if (supplied.has(edge)) continue;
    throw new Error(
      `Topology: origin ${origins.map((o) => `"${o}"`).join(", ")} needs "${edge}", but no topology declares it as input — the trigger cannot supply it, so ${origins.length === 1 ? "it" : "they"} could never fire.`,
    );
  }
  for (const edge of supplied) {
    if (wanted.has(edge)) continue;
    throw new Error(
      `Topology: declares input "${edge}", but no origin consumes it — a declared trigger nothing reads is a promise the program does not keep.`,
    );
  }
}

export interface Elaborated {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
  /**
   * Author-declared envelopes — metadata that rides **with a token** rather
   * than over a wire, and flows along lineage
   * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md).
   *
   * Kept apart from `edges` deliberately, even though both are `AnyEdgeDef`:
   * an envelope is never wired, never an input or output, and never appears in
   * the netlist. Folding the two tables would make every query that means "what
   * crosses a wire" have to exclude them.
   */
  envelopes: Record<string, AnyEdgeDef>;
  nodes: Record<string, NodeDecl>;
  wiring: Wiring;
  /**
   * The topologies nothing else references — the program's entry points, each
   * carrying the full contract (`input`, `output`, `terminals`). Empty for a
   * program with no `.topology` at all: a declaration-only tree has no run to
   * begin or finish, so there is nothing to require of it.
   */
  entries: CompositeDecl[];
  /**
   * Which topology each node key was declared in — the lookup a zone is read
   * through (`zones.ts`). Recorded here rather than derived from the qualified
   * key because an entry's own nodes carry no prefix, so the key alone cannot
   * say where an unqualified node came from.
   */
  declaredIn: Record<string, string>;
  /**
   * Every declared topology by name, entries included — what `weir test` needs
   * to run a *composite* standalone, which the entry list alone cannot supply
   * because a composite is referenced and therefore not an entry.
   */
  topologies: CompositeDecl[];
}

/**
 * Load every `.field`/`.edge` file under `root`, resolving bare-name
 * references (within a field's value, and across compound edges) against
 * each other. Each file's name is its filename — no separate check needed
 * to keep that in sync with anything, since there's nothing else to sync.
 */
/**
 * Re-throws with the file the failure came from. Wrapped at the call site
 * rather than threaded through every parser, because the filename is known
 * exactly where a file is read and nowhere deeper — and "which file?" is the
 * first question anyone asks when a check fails.
 */
function inFile<T>(file: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    throw new Error(`${file}: ${(cause as Error).message}`, { cause });
  }
}

export async function elaborate(root: string): Promise<Elaborated> {
  const fields: Record<string, FieldDef> = {};
  for await (const file of glob("**/*.field", { cwd: root })) {
    const name = basename(file, ".field");
    if (name in fields) {
      throw new Error(`Duplicate field name "${name}" (also declared in "${file}").`);
    }
    const text = await readFile(`${root}/${file}`, "utf8");
    fields[name] = inFile(file, () => parseFieldFile(text));
  }

  const rawEdgeTextByName = new Map<string, { text: string; file: string }>();
  for await (const file of glob("**/*.edge", { cwd: root })) {
    const name = basename(file, ".edge");
    if (rawEdgeTextByName.has(name)) {
      throw new Error(`Duplicate edge name "${name}" (already declared elsewhere).`);
    }
    rawEdgeTextByName.set(name, { text: await readFile(`${root}/${file}`, "utf8"), file });
  }

  const rawEnvelopeTextByName = new Map<string, { text: string; file: string }>();
  for await (const file of glob("**/*.envelope", { cwd: root })) {
    const name = basename(file, ".envelope");
    if (rawEnvelopeTextByName.has(name) || rawEdgeTextByName.has(name)) {
      throw new Error(`Duplicate declaration name "${name}" (already declared as an edge or envelope).`);
    }
    rawEnvelopeTextByName.set(name, { text: await readFile(`${root}/${file}`, "utf8"), file });
  }

  const edges: Record<string, AnyEdgeDef> = {};
  const inProgress = new Set<string>();

  function resolve(name: string): FieldDef | AnyEdgeDef {
    if (name in fields) return fields[name]!;
    if (name in edges) return edges[name]!;

    const found = rawEdgeTextByName.get(name);
    if (found === undefined) {
      throw new Error(`Cannot resolve "${name}" — no .field or .edge file declares it.`);
    }
    if (inProgress.has(name)) {
      throw new Error(`Circular compound-edge reference involving "${name}".`);
    }

    inProgress.add(name);
    const edge = inFile(found.file, () => parseEdgeFile(found.text, name, resolve));
    inProgress.delete(name);
    edges[name] = edge;
    return edge;
  }

  for (const name of rawEdgeTextByName.keys()) {
    resolve(name);
  }

  synthesizeFailedEdges(edges);

  const resolveEdge: EdgeResolver = (name) => {
    const edge = edges[name];
    if (!edge) throw new Error(`Cannot resolve "${name}" — no .edge file declares it.`);
    return edge;
  };

  const nodeTextByName = new Map<string, { text: string; file: string }>();
  for await (const file of glob("**/*.node", { cwd: root })) {
    const name = basename(file, ".node");
    if (nodeTextByName.has(name)) {
      throw new Error(`Duplicate node name "${name}" (also declared in "${file}").`);
    }
    nodeTextByName.set(name, { text: await readFile(`${root}/${file}`, "utf8"), file });
  }

  // A raw pre-scan for `allOf:` combos, before the real parseNodeFile pass:
  // synthesizeAllOfFailedEdges needs to run before any node can reference a
  // combo's synthesized name (e.g. `input: Failed_A_B`), but which combos
  // exist can only be discovered by looking at what's actually declared —
  // unlike synthesizeFailedEdges, synthesizing for every possible subset
  // isn't an option (that's a powerset, not a linear scan).
  // The same pre-scan serves `gather:`, for the same reason: `Failed_Many_X`
  // exists only where a gather of `X` is declared, and a `.node` file may
  // itself declare `input: Failed_Many_X` to route one.
  const allOfCombosByKey = new Map<string, AnyEdgeDef[]>();
  const gatheredByName = new Map<string, AnyEdgeDef>();
  for (const { text } of nodeTextByName.values()) {
    const raw = parse(text) as { input?: unknown };
    if (raw.input === null || typeof raw.input !== "object" || Array.isArray(raw.input)) continue;
    if ("gather" in raw.input && typeof raw.input.gather === "string") {
      const edge = resolveEdge(raw.input.gather);
      gatheredByName.set(edge.name, edge);
    }
    if (!("allOf" in raw.input) || !Array.isArray(raw.input.allOf)) continue;
    const comboEdges = raw.input.allOf.map((n) => resolveEdge(n as string));
    const key = [...comboEdges].map((edge) => edge.name).sort().join(",");
    if (!allOfCombosByKey.has(key)) allOfCombosByKey.set(key, comboEdges);
  }
  synthesizeAllOfFailedEdges(edges, [...allOfCombosByKey.values()]);
  synthesizeGatherFailedEdges(edges, [...gatheredByName.values()]);

  // After edges, because an envelope's fields resolve through the same table.
  const envelopes: Record<string, AnyEdgeDef> = {};
  for (const [name, { text, file }] of rawEnvelopeTextByName) {
    envelopes[name] = inFile(file, () => parseEnvelopeFile(text, name, resolve));
  }

  /**
   * Every `scope:` names something that exists.
   *
   * Checked here rather than in the membrane, and that is an *improvement* on
   * where it used to live. `narrowIdentity` could only ever validate
   * `read:Identity:…`, because it has no access to the program's declared
   * envelopes — so generalizing `scope` to envelopes would have made a typo
   * (`read:Provenanc:trust`) silently resolve to nothing at runtime. Elaboration
   * has the whole table, so the same typo is now a `weir check` failure naming
   * the file (docs/superpowers/specs/2026-09-29-the-declared-envelope.md §5).
   */
  const assertScopeResolves = (node: NodeDecl): void => {
    for (const declaration of node.scope ?? []) {
      const [verb, target, field] = declaration.split(":");
      if (verb !== "read") {
        throw new Error(`scope "${declaration}": only "read:<Identity|Envelope>:<field>" is a verb today.`);
      }
      if (target === "Identity") continue;
      const envelope = target === undefined ? undefined : envelopes[target];
      if (envelope === undefined) {
        const known = ["Identity", ...Object.keys(envelopes)].join(", ");
        throw new Error(`scope "${declaration}": nothing named "${target}" is declared — known: ${known}.`);
      }
      if (field === undefined || !(field in envelope.fields)) {
        throw new Error(
          `scope "${declaration}": envelope "${target}" has no field "${field}" — it declares ${Object.keys(envelope.fields).join(", ")}.`,
        );
      }
    }
  };

  const nodes: Record<string, NodeDecl> = {};
  const anyOfAliases = new Map<string, string[]>();
  for (const [name, { text, file }] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown; for?: unknown };
    const isAnyOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "anyOf" in raw.input;
    if ("for" in raw) {
      // One file, N nodes — the same shape `anyOf` already produces, for a
      // different reason: `anyOf` desugars one declaration over several input
      // edges, `for` instantiates one template over several configurations
      // (docs/superpowers/specs/2026-09-29-instantiation.md §3).
      Object.assign(nodes, inFile(file, () => parseInstantiatedNodeFile(text, name, resolveEdge)));
    } else if (isAnyOf) {
      const shadows = inFile(file, () => parseAnyOfNodeFile(text, name, resolveEdge));
      Object.assign(nodes, shadows);
      anyOfAliases.set(name, Object.keys(shadows));
    } else {
      nodes[name] = inFile(file, () => parseNodeFile(text, name, resolveEdge));
    }
  }

  for (const node of Object.values(nodes)) assertScopeResolves(node);

  // A composite is referenced by name where a node would be, so the resolver
  // has to know them before any wiring is parsed — including a composite's
  // own inner wiring, which may reference another composite. Collected by a
  // cheap first pass over the .topology files (their filenames and whether
  // they declare `input:`), before anything is parsed for real.
  const compositeNames = new Set<string>();
  const topologyFiles: { file: string; text: string }[] = [];
  for await (const file of glob("**/*.topology", { cwd: root })) {
    const text = await readFile(`${root}/${file}`, "utf8");
    // Every `.topology` is a named, contracted topology now, so every name is
    // referenceable — which is what makes "entry" derivable from reference
    // rather than declared (spec §1).
    compositeNames.add(basename(file, ".topology"));
    topologyFiles.push({ file, text });
  }

  const resolveNodeName: NodeNameResolver = (name) => {
    const aliased = anyOfAliases.get(name);
    if (aliased) return aliased;
    if (!(name in nodes) && !compositeNames.has(name)) {
      // `noop_X` is synthesized here rather than up front — see
      // synthesizeNoopNode. An author's own `noop_X` .node file wins,
      // because it is already in `nodes` by now.
      if (!synthesizeNoopNode(nodes, edges, name)) {
        throw new Error(`Cannot resolve "${name}" — no .node file or composite .topology declares it.`);
      }
    }
    return [name];
  };

  // Parse every topology the same way, then ask which are referenced. A
  // topology another topology names is inlined where it is named; one nothing
  // names is an **entry point**, and its wiring is the program (spec §1).
  const declared = new Map<string, CompositeDecl>();
  for (const { file, text } of topologyFiles) {
    const name = basename(file, ".topology");
    declared.set(name, inFile(file, () => parseCompositeTopologyFile(text, name, resolveEdge, resolveNodeName)));
  }

  const referenced = new Set<string>();
  for (const decl of declared.values()) {
    for (const mentioned of [...decl.wiring.origins, ...Object.values(decl.wiring.feeds).flat()]) {
      // A topology naming *itself* is a cycle, not a reference that makes it a
      // non-entry — `inlineComposites` rejects that separately, and counting it
      // here would silently leave a program with no entry at all.
      if (declared.has(mentioned) && mentioned !== decl.name) referenced.add(mentioned);
    }
  }

  const composites = new Map<string, CompositeDecl>();
  const entries: CompositeDecl[] = [];
  let wiring: Wiring = { origins: [], feeds: {} };
  for (const [name, decl] of declared) {
    if (referenced.has(name)) {
      composites.set(name, decl);
      continue;
    }
    entries.push(decl);
    wiring = mergeWiring(wiring, decl.wiring);
  }

  assertTopologyContracts(
    nodes,
    [...composites.values()].map((c) => ({ kind: "Composite topology", ...c })),
  );
  if (composites.size > 0) {
    wiring = inlineComposites(nodes, wiring, composites);
  }

  // A root's terminal may name a **composite**, which is the natural thing to
  // write when a topology ends on one — and after inlining that name is gone,
  // replaced by qualified inner nodes. Expanding here rather than forbidding it
  // keeps the declaration in the author's vocabulary: they name the unit they
  // wired, not the unit's insides. Deliberately after inlining, because only
  // then is it known how many instances the composite was expanded into.
  const expanded = entries.map((entry) => ({
    ...entry,
    terminals: expandTerminals(entry.terminals, composites, nodes, anyOfAliases),
  }));
  assertTopologyContracts(nodes, expanded.map((e) => ({ kind: "Topology", ...e })));
  assertTriggerCoverage(nodes, wiring, expanded);

  assertWiringTypes(nodes, wiring, anyOfAliases);

  // Which topology declared each node key. An inlined node's key carries its
  // composite's prefix (`investigate/investigateIdentity`), so that half is
  // derivable — but an entry's own nodes carry none, and a node declared in no
  // topology at all has no entry here rather than a default one.
  const declaredIn: Record<string, string> = {};
  for (const [name, decl] of declared) {
    for (const inner of [...decl.wiring.origins, ...Object.values(decl.wiring.feeds).flat()]) {
      if (declared.has(inner)) continue; // a composite reference, not a node
      for (const shadow of anyOfAliases.get(inner) ?? [inner]) {
        if (shadow in nodes) declaredIn[shadow] = name;
        // The inlined copies of this composite's inner nodes, under every
        // instance prefix the inlining minted.
        for (const key of Object.keys(nodes)) {
          const slash = key.lastIndexOf("/");
          if (slash === -1 || key.slice(slash + 1) !== shadow) continue;
          const instance = key.slice(0, slash);
          if (instance === name || instance.startsWith(`${name}#`)) declaredIn[key] = name;
        }
      }
    }
  }

  return { fields, edges, envelopes, nodes, wiring, entries: expanded, topologies: [...declared.values()], declaredIn };
}
