/**
 * The `sys` queries (docs/design.md §8,
 * docs/superpowers/specs/2026-09-28-the-sys-queries.md).
 *
 * The readme's second argument is that a weir program is not a pile of files an
 * agent has to reconstruct meaning from — the topology, the ontology and the log
 * are all data, so the framework can answer questions about them. These are the
 * static half of that: everything derivable from the elaborated program, with no
 * run required.
 *
 * Two of them are newly answerable. Until a topology declared its `terminals`,
 * an edge produced and never consumed could not be told from *the answer* —
 * `Cookies` sits unconsumed forever and that is the point of it. With terminals
 * declared, "produced by a terminal" and "produced and dropped" are different
 * facts, and only one is a defect. Cut-vertex analysis needs the same
 * declaration, because it needs somewhere to be cut off *from*.
 */

import { outputEdgeNames } from "./elaborate.js";
import type { CompositeDecl, Wiring } from "./elaborate.js";
import { inputEdgeNames } from "./types.js";
import type { NodeDecl } from "./types.js";

export interface EdgeUse {
  edge: string;
  producedBy: string[];
  consumedBy: string[];
}

export interface Refinement {
  /** The narrower edge — one branch of a decision. */
  edge: string;
  /** The edge it refines: the input of the node that decided. */
  refines: string;
  /** The node whose `oneOf` made the decision, so the claim is attributable. */
  by: string;
}

export interface Orphan {
  edge: string;
  /** `orphaned` — nothing produces or consumes it. `dropped` — produced, unconsumed, and not a declared terminal output. */
  kind: "orphaned" | "dropped";
  producedBy: string[];
}

export interface Mediation {
  node: string;
  /** Origin→terminal pairs that can no longer reach each other with this node removed. */
  mediates: { origin: string; terminal: string }[];
  /** Pairs that still reach each other without it — the bypasses. */
  bypasses: { origin: string; terminal: string }[];
}

export interface SysReport {
  edges: EdgeUse[];
  refines: Refinement[];
  orphans: Orphan[];
  /**
   * Nodes declared and never wired into any topology. `assertWiringTypes`' Rule
   * B deliberately skips these — "can this node become ready" is a question
   * about a wiring, and a declared-but-unwired node is not in one — so nothing
   * has ever reported them. This is the "orphaned" half of the readme's promise
   * applied to nodes rather than edges.
   */
  unwiredNodes: string[];
  /** Synthesized `Failed_*` edges nothing routes. A count, not a list: every node can emit one, so this is a fact about the program's size rather than a finding. */
  unroutedFailureEdges: number;
}

/**
 * What these queries need, which is **declarations only** — no implementations,
 * no `--impl`, no run. That is the point rather than a convenience: the readme's
 * argument is that a weir program can be *read*, and everything here is
 * answerable from the files on disk.
 *
 * Typed against `Elaborated`'s shape rather than `Program`'s for exactly that
 * reason: requiring `NodeDef` would mean requiring an `fn` this never calls.
 */
type AnyProgram = {
  edges: Record<string, unknown>;
  nodes: Record<string, NodeDecl>;
  wiring: Wiring;
  entries?: CompositeDecl[];
};

/**
 * The nodes actually in the program — those the wiring reaches.
 *
 * Load-bearing rather than tidy. A composite's inner nodes survive inlining
 * under **both** names: the qualified key that is wired
 * (`investigate/investigateIdentity`) and the original that is not. Counting
 * both would report every edge a composite touches as having two producers, one
 * of which is not in the program. And a declared-but-unwired node genuinely does
 * not produce anything *here*.
 *
 * When there is no wiring at all — a declaration-only tree — every declared node
 * counts, because there is no program to be outside of.
 */
function wiredNodes(program: AnyProgram): Record<string, NodeDecl> {
  const wired = new Set([...program.wiring.origins, ...Object.values(program.wiring.feeds).flat()]);
  if (wired.size === 0) return program.nodes;
  return Object.fromEntries(Object.entries(program.nodes).filter(([name]) => wired.has(name)));
}

/** Nodes declared and never wired — see `SysReport.unwiredNodes`. */
export function unwiredNodes(program: AnyProgram): string[] {
  const wired = new Set([...program.wiring.origins, ...Object.values(program.wiring.feeds).flat()]);
  if (wired.size === 0) return [];
  return Object.keys(program.nodes)
    .filter((name) => !wired.has(name))
    // An inlined composite leaves its inner nodes behind under their original
    // names; those are not "declared and forgotten", they are the same node
    // wired under a qualified key. Reporting them would be noise with a
    // plausible-looking cause, which is worse than noise.
    .filter((name) => !Object.keys(program.nodes).some((k) => k.endsWith(`/${name}`) && wired.has(k)))
    .sort();
}

/** Every edge with the nodes that produce and consume it — the index the other answers are read against. */
export function edgeUses(program: AnyProgram): EdgeUse[] {
  const produced = new Map<string, string[]>();
  const consumed = new Map<string, string[]>();
  for (const [name, node] of Object.entries(wiredNodes(program))) {
    for (const edge of outputEdgeNames(node.output)) produced.set(edge, [...(produced.get(edge) ?? []), name]);
    for (const edge of inputEdgeNames(node.input)) consumed.set(edge, [...(consumed.get(edge) ?? []), name]);
  }
  return Object.keys(program.edges)
    .sort()
    .map((edge) => ({
      edge,
      producedBy: (produced.get(edge) ?? []).sort(),
      consumedBy: (consumed.get(edge) ?? []).sort(),
    }));
}

/**
 * The refinement relation: `X` refines `Y` when a **single-input** node takes
 * `Y` and emits `X` as one branch of a **`oneOf`** output.
 *
 * `design.md` §2: *"A node that makes a branching decision must emit distinct
 * edges: `Person -> one of {Child, Female, Male}`"* — refinement is how a
 * decision survives into the next node's type, so the relation is exactly that
 * shape and deliberately nothing wider:
 *
 * - `allOf` output is **fission**. Every branch fires, so nothing was decided.
 * - `many` output is **cardinality**. An `Entity` does not refine an `Alert`.
 * - An `allOf` *input* refines nothing: there is no single thing the decision
 *   was made about, and picking one of the bag by accident would put a wrong
 *   edge in the ontology. Recorded as undecided (spec §1) rather than guessed.
 */
export function refinements(program: AnyProgram): Refinement[] {
  const found: Refinement[] = [];
  for (const [name, node] of Object.entries(wiredNodes(program))) {
    if (node.input.kind !== "single" || node.output.kind !== "oneOf") continue;
    for (const branch of node.output.edges) {
      found.push({ edge: branch.name, refines: node.input.edge.name, by: name });
    }
  }
  return found.sort((a, b) => a.edge.localeCompare(b.edge) || a.refines.localeCompare(b.refines));
}

/**
 * Edges nothing uses, and edges produced then dropped.
 *
 * A declared **terminal** output is not a drop — it is the answer. That
 * distinction is what makes this query worth having and is why it could not
 * exist before topologies declared their ends.
 *
 * Unrouted `Failed_*` edges are deliberately excluded. Every node can emit one,
 * so an unrouted failure is the norm rather than a finding, and reporting them
 * would bury the two real findings in noise.
 */
/**
 * Edges referenced from inside another edge's fields — a compound field or a
 * `many` field, at any depth.
 *
 * Found by the query's first run against `examples/person-birthday`, which
 * reported `Address` as orphaned. It is not: `PersonWithAddress` embeds it as a
 * compound field. An edge can be part of the ontology without ever crossing a
 * wire, and a query that only reads node inputs and outputs cannot see that.
 *
 * **Synthesized `Failed_*` edges are skipped when collecting these**, and that
 * detail is the whole query. `Failed_X` embeds `X` as its `input` field by
 * construction, so counting those references makes *every* edge look nested and
 * nothing is ever orphaned — the first version of this fix reported an empty
 * findings list, which reads exactly like a clean program. A correction that
 * silently disables the check it was correcting is worse than the false positive
 * it fixed, and it took a debug print to tell the two apart.
 *
 * Deliberately **not transitive**. `PersonWithAddress` is itself orphaned here,
 * so `Address` is reachable only through dead weight — but reporting both at
 * once would mean a reader deleting the parent gets a *new* finding they thought
 * they had already dealt with. One finding, then the next, is easier to act on
 * than a cascade whose order nobody can predict.
 */
function nestedReferences(program: AnyProgram): Set<string> {
  const referenced = new Set<string>();
  const walk = (fields: Record<string, unknown>): void => {
    for (const field of Object.values(fields)) {
      if (field === null || typeof field !== "object") continue;
      const nested = "many" in field ? (field as { many: unknown }).many : field;
      if (nested === null || typeof nested !== "object" || !("fields" in nested)) continue;
      const edge = nested as { name?: string; fields: Record<string, unknown> };
      if (edge.name !== undefined) referenced.add(edge.name);
      walk(edge.fields);
    }
  };
  for (const [name, edge] of Object.entries(
    program.edges as Record<string, { fields?: Record<string, unknown> }>,
  )) {
    if (name.startsWith("Failed_")) continue;
    walk(edge.fields ?? {});
  }
  return referenced;
}

/**
 * Edges some other edge spread its fields from (`"...Name":`).
 *
 * A spread **copies** fields rather than embedding the source, so after
 * elaboration the source is a declared edge that nothing produces, consumes or
 * nests — indistinguishable, to `orphans`, from genuine dead weight. Reported
 * as such on the first real program anyone pointed at `weir sys`, which is how
 * it was found: `Provenanced` exists precisely to be spread, and was named a
 * defect for doing its job.
 *
 * Read off the elaborated edge's own `spreadFrom` rather than re-parsing, so
 * the fact travels with the edge wherever it goes.
 */
function spreadSources(program: AnyProgram): Set<string> {
  const sources = new Set<string>();
  for (const edge of Object.values(program.edges as Record<string, { spreadFrom?: string }>)) {
    if (edge.spreadFrom !== undefined) sources.add(edge.spreadFrom);
  }
  return sources;
}

export function orphans(program: AnyProgram): Orphan[] {
  const uses = edgeUses(program);
  const nested = nestedReferences(program);
  const spread = spreadSources(program);
  const answers = new Set((program.entries ?? []).flatMap((entry) => outputEdgeNames(entry.output)));
  const found: Orphan[] = [];
  for (const use of uses) {
    if (use.edge.startsWith("Failed_")) continue;
    if (use.producedBy.length === 0 && use.consumedBy.length === 0) {
      // Unless another edge embeds it, or spreads its fields from it: part of
      // the ontology without ever crossing a wire.
      if (!nested.has(use.edge) && !spread.has(use.edge)) {
        found.push({ edge: use.edge, kind: "orphaned", producedBy: [] });
      }
      continue;
    }
    if (use.producedBy.length > 0 && use.consumedBy.length === 0 && !answers.has(use.edge)) {
      found.push({ edge: use.edge, kind: "dropped", producedBy: use.producedBy });
    }
  }
  return found;
}

/** Which nodes are reachable from `from`, following `feeds`, with `without` removed. */
function reachableFrom(program: AnyProgram, from: string, without?: string): Set<string> {
  const seen = new Set<string>();
  const frontier = [from];
  while (frontier.length > 0) {
    const node = frontier.pop()!;
    if (node === without || seen.has(node)) continue;
    seen.add(node);
    for (const child of program.wiring.feeds[node] ?? []) frontier.push(child);
  }
  return seen;
}

/**
 * Does removing `node` disconnect any terminal from any origin — and what still
 * gets through if it does?
 *
 * **Cut vertices and bypasses are one computation**, which is why they are one
 * function: remove the node, walk reachability, and compare. A pair that could
 * reach each other before and cannot now is *mediated*; a pair that still can is
 * a *bypass*.
 *
 * This is the query `design.md` §7's type-gate argument rests on — *"you cannot
 * call `charge_card` without an `AuthorizedPayment`, and only `authorize` mints
 * one"* — turned from a claim a reviewer checks by reading into an answer.
 */
export function mediation(program: AnyProgram, node: string): Mediation {
  const terminals = [...new Set((program.entries ?? []).flatMap((entry) => entry.terminals))];
  const mediates: Mediation["mediates"] = [];
  const bypasses: Mediation["bypasses"] = [];

  for (const origin of program.wiring.origins) {
    const before = reachableFrom(program, origin);
    const after = reachableFrom(program, origin, node);
    for (const terminal of terminals) {
      if (!before.has(terminal)) continue; // never connected; nothing to say
      if (after.has(terminal)) bypasses.push({ origin, terminal });
      else mediates.push({ origin, terminal });
    }
  }
  return { node, mediates, bypasses };
}

export function analyze(program: AnyProgram): SysReport {
  const edges = edgeUses(program);
  return {
    // Synthesized `Failed_*` edges nothing routes are counted, not listed: in
    // `soc-triage` they are nine of sixteen, and enumerating them buries the
    // seven edges the program is actually about.
    edges: edges.filter((e) => !(e.edge.startsWith("Failed_") && e.producedBy.length === 0 && e.consumedBy.length === 0)),
    refines: refinements(program),
    orphans: orphans(program),
    unwiredNodes: unwiredNodes(program),
    unroutedFailureEdges: edges.filter(
      (e) => e.edge.startsWith("Failed_") && e.producedBy.length === 0 && e.consumedBy.length === 0,
    ).length,
  };
}
