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
 * accepted. Writing one is `accept.ts`'s job (`acceptImplementation`), the
 * other half of this same seam.
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { elaborate } from "./elaborate.js";
import type { Wiring } from "./elaborate.js";
import { hashNode, hashSource } from "./hash.js";
import type { AnyEdgeDef, FieldDef, InputSpec, NodeDecl, NodeDef, OutputSpec } from "./types.js";

/**
 * Resolves the implementation accepted for a *given* contract hash, rather
 * than for whatever the declaration hashes to now. That distinction is the
 * whole point of replay: a declaration may have changed since an
 * invocation ran, and re-deriving the hash would resolve the wrong file or
 * none at all (docs/design.md §10, "Replay").
 */
export async function resolveImplementationAt<In extends InputSpec, O extends OutputSpec>(
  node: NodeDecl<In, O>,
  implRoot: string,
  contractHash: string,
): Promise<NodeDef<In, O>> {
  // An effect node's behaviour comes from a host-supplied handler, not from
  // a drafted implementation, so there is no file to find and nothing for
  // the acceptance gate to have accepted
  // (docs/superpowers/specs/2026-09-27-effects-are-data.md §1). Its `fn`
  // exists only to satisfy the type; the runtime never calls it, and calling
  // it directly is a bug loud enough to say so.
  if (node.effect !== undefined) {
    return {
      ...node,
      fn: (() => {
        throw new Error(
          `"${node.name}" is an effect ("${node.effect}") — it is performed by the runtime's handler, never called as an ordinary Fn.`,
        );
      }) as NodeDef<In, O>["fn"],
    };
  }

  const short = contractHash.slice(0, 8);
  const path = `${implRoot}/${node.name}/${short}.ts`;

  // Checked explicitly rather than inferred from `import()` throwing, for
  // two reasons. An `import()` is cached by URL, so a file that was loaded
  // and has since been deleted still resolves — which made a test pass on
  // one Node version and fail on another, since the two differ in when a
  // stripped-TypeScript module is re-read. And an import can throw for
  // reasons that are not "no implementation was accepted" — a syntax error
  // in the file, most obviously — which this error message would then
  // misreport. The message already claims "expected <path>"; this is the
  // check that makes the claim true.
  if (!existsSync(path)) {
    throw new Error(
      `No accepted implementation for "${node.name}" at contract hash "${short}" ` +
        `(expected "${path}"). Either the contract changed since acceptance, or ` +
        `no implementation was ever accepted for it.`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(`"${path}" could not be loaded: ${(cause as Error).message}`, { cause });
  }

  // Read separately from the import rather than derived from it: the module
  // is a parsed function and this is the artifact that was accepted. The
  // contract hash says which contract ran; this says which implementation of
  // it, which is what makes a replay mismatch attributable.
  const implementationHash = (await hashSource(readFileSync(path, "utf8"))).hash;

  if (typeof mod.default !== "function") {
    throw new Error(`"${path}" must default-export the node's Fn.`);
  }

  return { ...node, fn: mod.default as NodeDef<In, O>["fn"], implementationHash };
}

/**
 * The everyday path: derives the contract hash from the declaration itself,
 * then delegates to `resolveImplementationAt`. One resolution path, not
 * two — this is a thin wrapper, never a separate implementation of the
 * lookup.
 */
export async function resolveImplementation<In extends InputSpec, O extends OutputSpec>(
  node: NodeDecl<In, O>,
  implRoot: string,
): Promise<NodeDef<In, O>> {
  const { hash } = await hashNode(node);
  return resolveImplementationAt(node, implRoot, hash);
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
