/**
 * The elaborator's edge/field/node-contract half: turns hand-authored
 * `.field`/`.edge`/`.node` YAML into validated `FieldDef`/`EdgeDef`/`NodeDecl`
 * objects (docs/design.md §10). Topology loading is out of scope here —
 * deliberately deferred, same as the rest of the elaborator (§10, "deferred,
 * not designed away"). `.node` loading only resolves the contract — `input`,
 * `output`, `examples`, `closure` — never `fn`, which a data format can't
 * hold (§10) and stays the implementation tree's job, not this one's.
 *
 * No file kind declares its own `name` — the filename *is* the name (a
 * standalone `.field`/`.edge`/`.node` file has no parent map to be a key in,
 * the way an inline field does, so the filename is the only thing that could
 * name it; making that the *only* source of truth means a mismatched name
 * isn't a bug to catch, it's not a representable state at all).
 */

import { glob, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse } from "yaml";
import { defineEdge, defineField } from "./define.js";
import type { AnyEdgeDef, FieldDef, InputSpec, ManyEdgeDef, NodeDecl, OutputSpec } from "./types.js";

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

  const resolvedFields: Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "string") {
      resolvedFields[key] = resolveField(value);
    } else if (value !== null && typeof value === "object" && "many" in value) {
      const ref = (value as { many: unknown }).many;
      if (typeof ref !== "string" || ref.length === 0) {
        throw new Error(`"${key}.many" must be a bare edge-name reference, not an inline shape.`);
      }
      const resolved = resolveField(ref);
      if (!("fields" in resolved)) {
        throw new Error(`"${key}.many" references "${ref}", a field, not an edge — many is for edges only.`);
      }
      resolvedFields[key] = { many: resolved };
    } else {
      resolvedFields[key] = value as FieldDef;
    }
  }

  return defineEdge({
    name,
    label: label as string,
    description: description as string,
    ...(typeof index === "string" && { index }),
    fields: resolvedFields,
  });
}

/** Resolves a bare edge name (as used by a `.node` file's `input`/`output`) to its declared EdgeDef. */
export type EdgeResolver = (name: string) => AnyEdgeDef;

/**
 * Resolves a `.node` file's `input` value into an `InputSpec`. Handles the
 * two shapes `nodeSchema()` (schema.ts) validates today: a bare edge name
 * (`single`) and `{ every: [...] }` (docs/design-history.md, "`every`
 * lands"). `oneOf`/`allOf`/`many` never appear on `input` — those are
 * output-only fan-out shapes (docs/design-history.md, "Fan-out is three
 * different things").
 */
function resolveInputSpec(input: unknown, resolveEdge: EdgeResolver): InputSpec {
  if (typeof input === "string") {
    return { kind: "single", edge: resolveEdge(input) };
  }
  if (input !== null && typeof input === "object" && "every" in input) {
    return { kind: "every", edges: resolveEdgeNameList(input.every, "input.every", resolveEdge) };
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
      return { kind: "many", edge: resolveEdge(ref) };
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
  const { label, description, input, output, examples, closure } = raw as {
    label?: unknown;
    description?: unknown;
    input?: unknown;
    output?: unknown;
    examples?: unknown;
    closure?: unknown;
  };

  return {
    name,
    ...(typeof label === "string" && { label }),
    ...(typeof description === "string" && { description }),
    input: resolveInputSpec(input, resolveEdge),
    output: resolveOutputSpec(output, resolveEdge),
    ...(examples !== undefined && { examples: examples as NodeDecl["examples"] }),
    ...(closure !== undefined && { closure: closure as NodeDecl["closure"] }),
  };
}

export interface Elaborated {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
  nodes: Record<string, NodeDecl>;
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

  const resolveEdge: EdgeResolver = (name) => {
    const edge = edges[name];
    if (!edge) throw new Error(`Cannot resolve "${name}" — no .edge file declares it.`);
    return edge;
  };

  const nodes: Record<string, NodeDecl> = {};
  for await (const file of glob("**/*.node", { cwd: root })) {
    const name = basename(file, ".node");
    if (name in nodes) {
      throw new Error(`Duplicate node name "${name}" (also declared in "${file}").`);
    }
    const text = await readFile(`${root}/${file}`, "utf8");
    nodes[name] = parseNodeFile(text, name, resolveEdge);
  }

  return { fields, edges, nodes };
}
