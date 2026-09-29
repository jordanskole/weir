/**
 * The planner (docs/design.md §8,
 * docs/superpowers/specs/2026-09-28-the-planner.md).
 *
 * `plan(from, to)` — type-directed search returning candidate routes from one
 * edge to another, each a real `Wiring` you could write to a file and run.
 *
 * **It is the pulse loop with types instead of tokens**, and that is the whole
 * design. The tempting implementation is a graph path-finder, and the way that
 * is wrong is worth keeping in front of you: a linear path cannot pass through
 * an `allOf` node, because reaching one requires *two* edges to be available and
 * a path carries one. A path-based planner silently routes around every fan-in
 * in the program.
 *
 * So the rule is the one `runNetlist` already uses, one level up: a node fires
 * when every edge it declares is available as *tokens*; a node is **applicable**
 * when every edge it declares is available as *types*. Same predicate
 * (`inputEdgeNames ⊆ available`), same termination (a fixpoint, which is
 * quiescence with the tokens taken out). `allOf` and `gather` fall out rather
 * than needing cases.
 *
 * The **ranking** half of §8 is deliberately absent: routes come back ordered by
 * depth, which is a fact, rather than by observed success rate, which needs runs
 * of a real program this repo does not have. See the spec's §5 — a cost model
 * built from fixtures would rank by noise, and the repair would be a hand-tuned
 * weight, which §8 forbids in as many words.
 */

import { distinctContracts as sharedDistinctContracts, outputEdgeNames } from "./elaborate.js";
import type { CompositeDecl, Wiring } from "./elaborate.js";
import { crossings } from "./zones.js";
import type { Crossing } from "./zones.js";
import { inputEdgeNames } from "./types.js";
import type { NodeDecl } from "./types.js";

export interface Route {
  /** The nodes the route applies, in an order that satisfies every dependency. */
  nodes: string[];
  /** A real wiring: `N` feeds `M` when `N` produces an edge `M` consumes. Runnable as-is. */
  wiring: Wiring;
  /** Longest chain through `wiring` — the number of pulses `runNetlist` would take, not a node count. */
  depth: number;
  /** Nodes on the route that declare an `effect:`. Empty means the route is pure. */
  effectful: string[];
  /**
   * Edges on this route that cross a declared zone boundary — §8's
   * zone-crossings annotation, countable now that a topology declares where it
   * runs (2026-09-28-zones-are-a-line-in-the-topology.md). Empty for an unzoned
   * program, which is every program that has not asked the question.
   */
  crossings: Crossing[];
}

export interface PlanOptions {
  /** Maximum nodes in a route. Bounded enumeration is §8's own requirement, not a shortcut. */
  maxNodes?: number;
  /** Top-k pruning, likewise. */
  limit?: number;
}

type Planable = {
  nodes: Record<string, NodeDecl>;
  wiring?: Wiring;
  topologies?: CompositeDecl[];
  declaredIn?: Record<string, string>;
};

/**
 * The distinct node *contracts* to search over, keyed by name.
 *
 * Inlining leaves a composite's inner nodes under two keys — the qualified
 * position that a particular topology wired (`investigate/investigateIdentity`)
 * and the original declaration. They are the same contract, and the planner is
 * proposing a *new* topology, so an inlined instance is an artifact of somebody
 * else's wiring rather than a separate capability. Searching both produced
 * combinatorially many routes differing only in which copy they named.
 *
 * Unlike `weir sys`, this deliberately does **not** restrict to wired nodes: a
 * declared-but-unwired node is exactly what a planner exists to find a use for.
 *
 * The rule itself now lives in `elaborate.ts`, beside the inlining that creates
 * the duplicates: `test` needed the identical rule and had silently grown the
 * identical bug, reporting one declaration as two results under two names.
 */
function distinctContracts(program: Planable): Record<string, NodeDecl> {
  return sharedDistinctContracts(program.nodes);
}

/**
 * The edges a node makes available when applied.
 *
 * **The `Failed_*` exclusion is narrower than it looks, and the comment that
 * used to be here was wrong.** It claimed that without the filter every node's
 * implicit failure output would make almost everything reachable "via failure".
 * It would not: `outputEdgeNames` returns only *declared* outputs, and a
 * `Failed_X` is synthesized and emitted implicitly, never declared — so the
 * planner never sees one and the filter never fires. Removing it reddens
 * nothing, which is how this was caught.
 *
 * What it does guard is an author who declares `output: Failed_X` explicitly,
 * which the elaborator permits since the synthesized edges are real. Kept for
 * that, labelled so nobody reads it as the thing keeping failure routes out —
 * the reason those stay out is that they were never declared to begin with.
 */
function produces(node: NodeDecl): string[] {
  return outputEdgeNames(node.output).filter((edge) => !edge.startsWith("Failed_"));
}

/** `N` feeds `M` when `N` produces an edge `M` consumes — the same relation `weir sys` computes. */
function wiringFor(nodes: string[], decls: Record<string, NodeDecl>): Wiring {
  const feeds: Record<string, string[]> = {};
  const fed = new Set<string>();
  for (const from of nodes) {
    const out = new Set(produces(decls[from]!));
    const children = nodes.filter((to) => to !== from && inputEdgeNames(decls[to]!.input).some((e) => out.has(e)));
    if (children.length > 0) {
      feeds[from] = children.sort();
      for (const child of children) fed.add(child);
    }
  }
  return { origins: nodes.filter((n) => !fed.has(n)).sort(), feeds };
}

/**
 * The longest chain through a wiring — the pulse count, which is what makes
 * `depth` mean something a reader already understands rather than being an
 * artifact of how the search happened to enumerate.
 *
 * The visited set is per-path rather than global: a node reachable by two routes
 * of different lengths must report the longer one, and a shared `seen` would
 * stop at whichever arrived first.
 */
function longestChain(wiring: Wiring): number {
  const walk = (node: string, onPath: Set<string>): number => {
    if (onPath.has(node)) return 0; // a cycle contributes no further depth
    const next = wiring.feeds[node] ?? [];
    if (next.length === 0) return 1;
    const deeper = new Set(onPath).add(node);
    return 1 + Math.max(...next.map((child) => walk(child, deeper)));
  };
  if (wiring.origins.length === 0) return 0;
  return Math.max(...wiring.origins.map((origin) => walk(origin, new Set())));
}

/**
 * Candidate routes from `from` to `to`.
 *
 * Enumerates *sequences* of applications — at each step apply one applicable
 * node — bounded by `maxNodes`, and deduplicates by the resulting **node set**,
 * so two orderings of the same route are one answer rather than a factorial of
 * them. Returns the top `limit` by depth.
 *
 * A route is minimal only in the sense that the search stops as soon as `to`
 * becomes available: it never applies a node after reaching the target, but it
 * may include one that turned out not to be needed. Said plainly rather than
 * claimed otherwise — minimality would mean a subset search on top of this, and
 * the ordering by depth already surfaces the tight routes first.
 */
export function plan(program: Planable, from: string, to: string, opts: PlanOptions = {}): Route[] {
  const maxNodes = opts.maxNodes ?? 8;
  const limit = opts.limit ?? 10;
  const decls = distinctContracts(program);

  const found = new Map<string, Route>();
  const seenStates = new Set<string>();

  const search = (available: Set<string>, applied: string[]): void => {
    if (found.size >= limit * 4) return; // enough candidates to rank; §8's top-k
    if (available.has(to)) {
      // Sorted, so two orderings of one node set are one answer. Belt and
      // braces today: `seenStates` below already prunes by the same sorted set
      // before a second ordering can reach here, so reverting this alone reddens
      // nothing. Kept because the two answer different questions — that one
      // bounds the search, this one defines the result.
      const key = [...applied].sort().join(" ");
      if (!found.has(key)) {
        const wiring = wiringFor(applied, decls);
        found.set(key, {
          nodes: [...applied],
          wiring,
          depth: longestChain(wiring),
          effectful: applied.filter((n) => decls[n]!.effect !== undefined).sort(),
          // The route's *own* wiring, not the program's — a candidate route is a
          // topology that does not exist yet, so its hops are the ones it would
          // create rather than any the program already has.
          crossings:
            program.topologies === undefined || program.declaredIn === undefined
              ? []
              : crossings({ nodes: decls, wiring, topologies: program.topologies, declaredIn: program.declaredIn }),
        });
      }
      return;
    }
    if (applied.length >= maxNodes) return;

    // Two different orderings reaching the same (available, applied-set) state
    // explore the same subtree; visiting it once is what keeps this tractable.
    const stateKey = `${[...applied].sort().join(" ")}`;
    if (seenStates.has(stateKey)) return;
    seenStates.add(stateKey);

    for (const [name, decl] of Object.entries(decls)) {
      if (applied.includes(name)) continue;
      const needs = inputEdgeNames(decl.input);
      if (!needs.every((edge) => available.has(edge))) continue;
      const next = new Set(available);
      for (const edge of produces(decl)) next.add(edge);
      // Applying a node that adds nothing new cannot help reach the target.
      if (next.size === available.size) continue;
      search(next, [...applied, name]);
    }
  };

  search(new Set([from]), []);

  return [...found.values()].sort((a, b) => a.depth - b.depth || a.nodes.length - b.nodes.length).slice(0, limit);
}
