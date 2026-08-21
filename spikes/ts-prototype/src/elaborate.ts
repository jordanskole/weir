/**
 * The elaborator's edge/field half: turns hand-authored `.field`/`.edge` YAML
 * into validated `FieldDef`/`EdgeDef` objects (docs/design.md §10). `.node`
 * and topology loading are out of scope here — deliberately deferred, same
 * as the rest of the elaborator (§10, "deferred, not designed away").
 */

import { glob, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse } from "yaml";
import { defineEdge, defineField } from "./define.js";
import type { AnyEdgeDef, FieldDef } from "./types.js";

export interface LoadedField {
  name: string;
  field: FieldDef;
}

/** Parse a `.field` file's YAML text into its declared name and a validated FieldDef. */
export function parseFieldFile(yamlText: string): LoadedField {
  const raw = parse(yamlText) as Record<string, unknown>;
  const { name, ...fieldData } = raw;

  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`.field file is missing a "name".`);
  }

  const field = defineField(fieldData as unknown as FieldDef);
  return { name, field };
}

export interface LoadedEdge {
  name: string;
  edge: AnyEdgeDef;
}

/**
 * Given a bare-string field value (e.g. `email: email` or `address: Address`),
 * resolves it to the FieldDef/EdgeDef declared under that name — a sibling
 * `.field` or `.edge` file, whichever extension exists (docs/design.md §10's
 * "globs by extension" convention, applied one layer down).
 */
export type FieldResolver = (name: string) => FieldDef | AnyEdgeDef;

/** Parse an `.edge` file's YAML text into its declared name and a validated EdgeDef. */
export function parseEdgeFile(yamlText: string, resolveField: FieldResolver): LoadedEdge {
  const raw = parse(yamlText) as Record<string, unknown>;
  const { name, description, index, fields } = raw as {
    name?: unknown;
    description?: unknown;
    index?: unknown;
    fields?: Record<string, unknown>;
  };

  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`.edge file is missing a "name".`);
  }

  const resolvedFields: Record<string, FieldDef | AnyEdgeDef> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    resolvedFields[key] = typeof value === "string" ? resolveField(value) : (value as FieldDef);
  }

  const edge = defineEdge({
    name,
    description: description as string,
    ...(typeof index === "string" && { index }),
    fields: resolvedFields,
  });
  return { name, edge };
}

export interface Elaborated {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
}

/**
 * Load every `.field`/`.edge` file under `root`, resolving bare-name
 * references (within a field's value, and across compound edges) against
 * each other. A `.field`/`.edge` file's declared `name` must match its own
 * filename — the file is the thing other files reference it by, so a
 * mismatch would silently orphan it.
 */
export async function elaborate(root: string): Promise<Elaborated> {
  const fields: Record<string, FieldDef> = {};
  for await (const file of glob("**/*.field", { cwd: root })) {
    const text = await readFile(`${root}/${file}`, "utf8");
    const { name, field } = parseFieldFile(text);
    assertNameMatchesFilename(name, file, ".field");
    if (name in fields) {
      throw new Error(`Duplicate field name "${name}" (also declared in "${file}").`);
    }
    fields[name] = field;
  }

  const rawEdgeTextByName = new Map<string, string>();
  for await (const file of glob("**/*.edge", { cwd: root })) {
    const text = await readFile(`${root}/${file}`, "utf8");
    const peeked = parse(text) as { name?: unknown };
    if (typeof peeked.name !== "string" || peeked.name.length === 0) {
      throw new Error(`"${file}" is missing a "name".`);
    }
    assertNameMatchesFilename(peeked.name, file, ".edge");
    if (rawEdgeTextByName.has(peeked.name)) {
      throw new Error(`Duplicate edge name "${peeked.name}" (already declared elsewhere).`);
    }
    rawEdgeTextByName.set(peeked.name, text);
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
    const { edge } = parseEdgeFile(text, resolve);
    inProgress.delete(name);
    edges[name] = edge;
    return edge;
  }

  for (const name of rawEdgeTextByName.keys()) {
    resolve(name);
  }

  return { fields, edges };
}

function assertNameMatchesFilename(name: string, file: string, extension: string): void {
  const expected = basename(file, extension);
  if (name !== expected) {
    throw new Error(
      `"${file}" declares name "${name}", but its filename implies "${expected}" — they must match.`,
    );
  }
}
