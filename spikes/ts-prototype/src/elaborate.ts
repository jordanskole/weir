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
import { failedEdgeName, failedAllOfEdgeName } from "./types.js";
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

/** Parse a `.field` file's YAML text into a validated FieldDef. */
export function parseFieldFile(yamlText: string): FieldDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.field files don't declare "name" — the filename is the name.`);
  }
  return defineField(raw as unknown as FieldDef);
}

/**
 * Given a bare-string field value (e.g. `email: email` or `address: Address`),
 * resolves it to the FieldDef/EdgeDef declared under that name — a sibling
 * `.field` or `.edge` file, whichever extension exists (docs/design.md §10's
 * "globs by extension" convention, applied one layer down).
 */
export type FieldResolver = (name: string) => FieldDef | AnyEdgeDef;

/** Matches a `.edge` file's `...Name` spread key (docs/superpowers/specs/2026-09-09-edge-spread.md), capturing the source edge's name. */
const SPREAD_KEY = /^\.\.\.(.+)$/;

/** Parse an `.edge` file's YAML text (and its filename-derived name) into a validated EdgeDef. */
export function parseEdgeFile(yamlText: string, name: string, resolveField: FieldResolver): AnyEdgeDef {
  const raw = parse(yamlText) as Record<string, unknown>;
  if ("name" in raw) {
    throw new Error(`.edge files don't declare "name" — the filename is the name.`);
  }
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
      resolvedFields[key] = value as FieldDef;
    }
  }

  return defineEdge({
    name,
    label: label as string,
    description: description as string,
    ...(typeof index === "string" ? { index } : spreadIndex !== undefined && { index: spreadIndex }),
    fields: resolvedFields,
  });
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
  throw new Error(`Unrecognized "input" shape: ${JSON.stringify(input)}.`);
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
    input?: unknown;
    output?: unknown;
    examples?: unknown;
    closure?: unknown;
    properties?: unknown;
  };

  return {
    name,
    ...(typeof label === "string" && { label }),
    ...(typeof description === "string" && { description }),
    input: resolveInputSpec(input, resolveEdge),
    output: resolveOutputSpec(output, resolveEdge),
    ...(examples !== undefined && { examples: examples as NodeDecl["examples"] }),
    ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),
    ...(properties !== undefined && { properties: properties as NodeDecl["properties"] }),
  };
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
export function parseTopologyFile(yamlText: string, resolveNodeName: NodeNameResolver): Wiring {
  const raw = (parse(yamlText) as Record<string, unknown> | null) ?? {};
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
 * What a node's declared output can actually put on the wire, with the
 * multiplicity it arrives at. `oneOf`/`allOf` contribute each of their
 * branches at single multiplicity — the runtime logs one instance per
 * tagged branch (`runtime.ts`'s `logOutput`) — while `many` contributes
 * its one edge flagged `many`, because a `many` result is a single token
 * carrying a keyed collection, never N separate instances
 * (docs/design-history.md, "`many` is a collection, keyed by index, not an
 * array").
 */
function producedEdges(node: NodeDecl): { name: string; many: boolean }[] {
  const output = node.output;
  const declared =
    output.kind === "single"
      ? [{ name: output.edge.name, many: false }]
      : output.kind === "many"
        ? [{ name: output.edge.name, many: true }]
        : output.edges.map((edge) => ({ name: edge.name, many: false }));

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
      : failedAllOfEdgeName(node.input.edges);

  return [...declared, { name: failed, many: false }];
}

/**
 * The edge names a node declares needing. Always single multiplicity:
 * `resolveInputSpec` builds only `single` and `allOf`, so no input is ever
 * `many` — which is what makes the `many`-output rule below total rather
 * than a special case.
 */
function consumedEdges(input: InputSpec): string[] {
  return input.kind === "single" ? [input.edge.name] : input.edges.map((edge) => edge.name);
}

/**
 * Elaboration-time wiring checks — the "will not compile" gate for a
 * topology whose arcs don't typecheck against the contracts they connect.
 * Two rules:
 *
 * **A, arc soundness.** Every arc must carry at least one edge the consumer
 * declares, at single multiplicity. The motivating failure is a `many X`
 * output wired into a `single X` input: the names match, so it looks right,
 * but no input is ever `many`, so nothing on that arc can ever satisfy the
 * consumer. Before this check that program elaborated clean, ran to
 * `quiescence` with `failures: []`, and surfaced as a schema error two
 * nodes downstream complaining that `X` was missing fields it never had —
 * because the payload was a *collection of* `X` checked against the schema
 * for one `X` (docs/open-questions.md, "There is no fan-out primitive").
 * An arc matching no name at all is the plainer miswiring, reported
 * separately so the message can say what each side actually declares.
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
        return produced.some((p) => !p.many && consumed.has(p.name));
      });
      if (satisfiable) continue;

      const consumed = new Set(group.flatMap((sibling) => consumedEdges(nodes[sibling]!.input)));
      const collectionMatch = produced.find((p) => p.many && consumed.has(p.name));
      if (collectionMatch) {
        throw new Error(
          `Wiring: "${child}" consumes "${collectionMatch.name}", but its parent "${parent}" produces "many ${collectionMatch.name}" — a many output is one token carrying a keyed collection, not one instance per element, so nothing on this arc can satisfy it.`,
        );
      }
      throw new Error(
        `Wiring: the arc "${parent}" -> "${child}" carries nothing "${child}" can use — "${parent}" produces ${produced.map((p) => `"${p.many ? `many ${p.name}` : p.name}"`).join(", ")}; "${child}" consumes ${[...consumed].map((name) => `"${name}"`).join(", ")}.`,
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
      parents.flatMap((parent) => producedEdges(nodes[parent]!).filter((p) => !p.many).map((p) => p.name)),
    );
    const missing = consumedEdges(nodes[name]!.input).filter((edge) => !covered.has(edge));
    if (missing.length === 0) continue;
    // A shadow that can never become ready is fine as long as one of its
    // siblings can — the group, not the shadow, is what the author wired.
    const group = groupOf(name);
    if (group.length > 1) {
      const anySiblingReady = group.some((sibling) => {
        const siblingCovered = new Set(
          (parentsOf.get(sibling) ?? []).flatMap((parent) =>
            producedEdges(nodes[parent]!).filter((p) => !p.many).map((p) => p.name),
          ),
        );
        return consumedEdges(nodes[sibling]!.input).every((edge) => siblingCovered.has(edge));
      });
      if (anySiblingReady) continue;
    }
    throw new Error(
      `Wiring: "${name}" declares needing ${missing.map((edge) => `"${edge}"`).join(", ")}, but nothing wired into it produces ${missing.length === 1 ? "it" : "them"} — its parents are ${parents.length === 0 ? "none" : parents.map((p) => `"${p}"`).join(", ")}.`,
    );
  }
}

export interface Elaborated {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
  nodes: Record<string, NodeDecl>;
  wiring: Wiring;
}

/**
 * Load every `.field`/`.edge` file under `root`, resolving bare-name
 * references (within a field's value, and across compound edges) against
 * each other. Each file's name is its filename — no separate check needed
 * to keep that in sync with anything, since there's nothing else to sync.
 */
export async function elaborate(root: string): Promise<Elaborated> {
  const fields: Record<string, FieldDef> = {};
  for await (const file of glob("**/*.field", { cwd: root })) {
    const name = basename(file, ".field");
    if (name in fields) {
      throw new Error(`Duplicate field name "${name}" (also declared in "${file}").`);
    }
    const text = await readFile(`${root}/${file}`, "utf8");
    fields[name] = parseFieldFile(text);
  }

  const rawEdgeTextByName = new Map<string, string>();
  for await (const file of glob("**/*.edge", { cwd: root })) {
    const name = basename(file, ".edge");
    if (rawEdgeTextByName.has(name)) {
      throw new Error(`Duplicate edge name "${name}" (already declared elsewhere).`);
    }
    rawEdgeTextByName.set(name, await readFile(`${root}/${file}`, "utf8"));
  }

  const edges: Record<string, AnyEdgeDef> = {};
  const inProgress = new Set<string>();

  function resolve(name: string): FieldDef | AnyEdgeDef {
    if (name in fields) return fields[name]!;
    if (name in edges) return edges[name]!;

    const text = rawEdgeTextByName.get(name);
    if (text === undefined) {
      throw new Error(`Cannot resolve "${name}" — no .field or .edge file declares it.`);
    }
    if (inProgress.has(name)) {
      throw new Error(`Circular compound-edge reference involving "${name}".`);
    }

    inProgress.add(name);
    const edge = parseEdgeFile(text, name, resolve);
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

  const nodeTextByName = new Map<string, string>();
  for await (const file of glob("**/*.node", { cwd: root })) {
    const name = basename(file, ".node");
    if (nodeTextByName.has(name)) {
      throw new Error(`Duplicate node name "${name}" (also declared in "${file}").`);
    }
    nodeTextByName.set(name, await readFile(`${root}/${file}`, "utf8"));
  }

  // A raw pre-scan for `allOf:` combos, before the real parseNodeFile pass:
  // synthesizeAllOfFailedEdges needs to run before any node can reference a
  // combo's synthesized name (e.g. `input: Failed_A_B`), but which combos
  // exist can only be discovered by looking at what's actually declared —
  // unlike synthesizeFailedEdges, synthesizing for every possible subset
  // isn't an option (that's a powerset, not a linear scan).
  const allOfCombosByKey = new Map<string, AnyEdgeDef[]>();
  for (const text of nodeTextByName.values()) {
    const raw = parse(text) as { input?: unknown };
    if (raw.input === null || typeof raw.input !== "object" || Array.isArray(raw.input)) continue;
    if (!("allOf" in raw.input) || !Array.isArray(raw.input.allOf)) continue;
    const comboEdges = raw.input.allOf.map((n) => resolveEdge(n as string));
    const key = [...comboEdges].map((edge) => edge.name).sort().join(",");
    if (!allOfCombosByKey.has(key)) allOfCombosByKey.set(key, comboEdges);
  }
  synthesizeAllOfFailedEdges(edges, [...allOfCombosByKey.values()]);

  const nodes: Record<string, NodeDecl> = {};
  const anyOfAliases = new Map<string, string[]>();
  for (const [name, text] of nodeTextByName) {
    const raw = parse(text) as { input?: unknown };
    const isAnyOf =
      raw.input !== null && typeof raw.input === "object" && !Array.isArray(raw.input) && "anyOf" in raw.input;
    if (isAnyOf) {
      const shadows = parseAnyOfNodeFile(text, name, resolveEdge);
      Object.assign(nodes, shadows);
      anyOfAliases.set(name, Object.keys(shadows));
    } else {
      nodes[name] = parseNodeFile(text, name, resolveEdge);
    }
  }

  const resolveNodeName: NodeNameResolver = (name) => {
    const aliased = anyOfAliases.get(name);
    if (aliased) return aliased;
    if (!(name in nodes)) {
      throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    }
    return [name];
  };

  let wiring: Wiring = { origins: [], feeds: {} };
  for await (const file of glob("**/*.topology", { cwd: root })) {
    const text = await readFile(`${root}/${file}`, "utf8");
    wiring = mergeWiring(wiring, parseTopologyFile(text, resolveNodeName));
  }

  assertWiringTypes(nodes, wiring, anyOfAliases);

  return { fields, edges, nodes, wiring };
}
