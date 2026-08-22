/**
 * The elaborator's edge/field half: turns hand-authored `.field`/`.edge` YAML
 * into validated `FieldDef`/`EdgeDef` objects (docs/design.md §10). `.node`
 * and topology loading are out of scope here — deliberately deferred, same
 * as the rest of the elaborator (§10, "deferred, not designed away").
 *
 * Neither file kind declares its own `name` — the filename *is* the name (a
 * standalone `.field`/`.edge` file has no parent map to be a key in, the way
 * an inline field does, so the filename is the only thing that could name
 * it; making that the *only* source of truth means a mismatched name isn't
 * a bug to catch, it's not a representable state at all).
 */

import { glob, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse } from "yaml";
import { defineEdge, defineField } from "./define.js";
import type { AnyEdgeDef, FieldDef, ManyEdgeDef } from "./types.js";

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

export interface Elaborated {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
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

  return { fields, edges };
}
