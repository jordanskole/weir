/**
 * The elaborator's implementation-seam half: pairs a contract-only
 * `NodeDecl` (from elaborate.ts's `.node` loading) with its accepted `Fn`,
 * producing a real, runnable `NodeDef` (docs/design.md §10, "The seam").
 *
 * Resolution is by name alone — `{node-name}/<contract-hash>.ts` in the
 * implementation tree, the node's own contract hash (hash.ts's `hashNode`)
 * standing in for the path a stored reference would otherwise need to
 * survive across the declarations/implementations package boundary (§10).
 * Draft attempts an agent iterates on before acceptance aren't versions and
 * don't live here (§10) — this only ever reads a file that's already been
 * accepted; writing new ones is a separate, not-yet-built concern (§6's
 * acceptance gate).
 */

import { pathToFileURL } from "node:url";
import { elaborate } from "./elaborate.js";
import type { Wiring } from "./elaborate.js";
import { hashNode } from "./hash.js";
import type { AnyEdgeDef, FieldDef, InputSpec, NodeDecl, NodeDef, OutputSpec } from "./types.js";

export async function resolveImplementation<In extends InputSpec, O extends OutputSpec>(
  node: NodeDecl<In, O>,
  implRoot: string,
): Promise<NodeDef<In, O>> {
  const { short } = await hashNode(node);
  const path = `${implRoot}/${node.name}/${short}.ts`;

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(
      `No accepted implementation for "${node.name}" at contract hash "${short}" ` +
        `(expected "${path}"). Either the contract changed since acceptance, or ` +
        `no implementation was ever accepted for it.`,
      { cause },
    );
  }

  if (typeof mod.default !== "function") {
    throw new Error(`"${path}" must default-export the node's Fn.`);
  }

  return { ...node, fn: mod.default as NodeDef<In, O>["fn"] };
}

/** Everything `elaborate()` produces, with every node contract resolved to a real, runnable NodeDef. */
export interface Program {
  fields: Record<string, FieldDef>;
  edges: Record<string, AnyEdgeDef>;
  nodes: Record<string, NodeDef>;
  wiring: Wiring;
}

/**
 * Crosses the declarations/implementations package boundary in one call
 * (docs/design.md §10): loads every `.field`/`.edge`/`.node`/`.topology`
 * under `declRoot` (elaborate.ts), then resolves each declared node's
 * accepted implementation under `implRoot` (`resolveImplementation`,
 * above).
 */
export async function elaborateWithImplementations(declRoot: string, implRoot: string): Promise<Program> {
  const { fields, edges, nodes, wiring } = await elaborate(declRoot);

  const resolved = await Promise.all(
    Object.entries(nodes).map(
      async ([name, decl]) => [name, await resolveImplementation(decl, implRoot)] as const,
    ),
  );

  return { fields, edges, nodes: Object.fromEntries(resolved), wiring };
}
