/**
 * Zones (docs/design.md §7,
 * docs/superpowers/specs/2026-09-28-zones-are-a-line-in-the-topology.md).
 *
 * §7 says *"zones annotate where a node runs"*, which reads as a field on every
 * `.node` — repeated across every node of a subgraph that all run in the same
 * place. **A zone is a line in the topology instead.** A `.topology` already
 * declares where a unit begins, where it ends and what it contains; where it
 * *runs* is the same kind of fact about the same unit.
 *
 * The rest of §7 is unchanged and reads better for it: *"edges crossing a zone
 * boundary are the network hops"* becomes a lookup rather than an analysis.
 */

import type { CompositeDecl, Wiring } from "./elaborate.js";
import type { NodeDecl } from "./types.js";
import { inputEdgeNames } from "./types.js";
import { outputEdgeNames } from "./elaborate.js";

export interface Crossing {
  from: string;
  to: string;
  edge: string;
  fromZone: string;
  toZone: string;
  /**
   * The classifications the crossing edge carries, from its fields — `design.md`
   * §7's other half. Sorted and deduplicated; empty when the edge carries
   * nothing labelled.
   *
   * This is what turns "where are the network hops" into §7's actual claim:
   * *"no edge carrying an unredacted PII field may cross into a non-client
   * zone"* is a question about exactly this list.
   */
  carries: string[];
}

type FieldLike = { classification?: string; fields?: Record<string, unknown>; many?: unknown };

/**
 * Every classification an edge carries, walking compound and `many` fields to
 * any depth.
 *
 * Nested, because an edge's sensitivity is not only in its own scalar fields: a
 * `Person` embedded in an `Order` takes its labels with it, and a leakage query
 * that only read the top level would pass an edge whose PII is one level down.
 * That is the same recursive shape `assertPayload` and `fingerprint` already
 * walk — plus a cycle guard those two do not carry. They assume acyclic
 * definitions, which `elaborate` enforces; this runs on a query path over
 * author-supplied shapes, and without the guard a self-reference throws
 * `RangeError: Maximum call stack size exceeded`.
 */
export function classificationsOf(edge: { fields?: Record<string, unknown> }): string[] {
  const found = new Set<string>();
  const walk = (fields: Record<string, unknown>, seen: Set<unknown>): void => {
    for (const raw of Object.values(fields)) {
      if (raw === null || typeof raw !== "object") continue;
      const field = raw as FieldLike;
      if (typeof field.classification === "string") found.add(field.classification);
      const nested = (field.many ?? field) as FieldLike;
      // Guard against a self-referential edge definition rather than assuming
      // acyclicity: `fingerprint` assumes it, but this walks author-supplied
      // shapes on a query path where a hang would be the whole command.
      if (nested.fields === undefined || seen.has(nested)) continue;
      walk(nested.fields, new Set(seen).add(nested));
    }
  };
  walk(edge.fields ?? {}, new Set());
  return [...found].sort();
}

type Zoned = {
  nodes: Record<string, NodeDecl>;
  wiring: Wiring;
  topologies: CompositeDecl[];
  declaredIn: Record<string, string>;
  /** Optional so a hand-built fixture need not carry a whole edge table to ask about placement; a crossing then carries no classifications. */
  edges?: Record<string, { fields?: Record<string, unknown> }>;
};

/**
 * Each node's zone, by node key — absent when it has none.
 *
 * **Unzoned is not a zone.** A node in a topology that declared no `zone:` gets
 * no entry rather than a default one, because the difference decides what counts
 * as a crossing: nothing was claimed about where it runs, so no boundary was
 * declared for an edge to cross. A default would manufacture crossings nobody
 * wrote.
 *
 * A node wired into two differently-zoned topologies gets one entry per inlined
 * instance, which is correct — its *contract* is one thing and its *placements*
 * are two.
 */
export function zoneOf(program: Zoned): Record<string, string> {
  const byTopology = new Map(program.topologies.map((t) => [t.name, t.zone]));
  const zones: Record<string, string> = {};
  for (const [node, topology] of Object.entries(program.declaredIn)) {
    const zone = byTopology.get(topology);
    if (zone !== undefined) zones[node] = zone;
  }
  return zones;
}

/**
 * Edges that cross a zone boundary — §7's network hops.
 *
 * An edge crosses when a node in one zone feeds a node in a different one. Two
 * nodes in the same zone do not cross, and neither does a zoned node feeding an
 * unzoned one: that is an undeclared placement rather than a declared boundary.
 */
export function crossings(program: Zoned): Crossing[] {
  const zones = zoneOf(program);
  const found: Crossing[] = [];
  for (const [from, children] of Object.entries(program.wiring.feeds)) {
    const fromZone = zones[from];
    if (fromZone === undefined) continue;
    const decl = program.nodes[from];
    if (decl === undefined) continue; // reported by the wiring scan, not here
    const produced = new Set(outputEdgeNames(decl.output));
    for (const to of children) {
      const toZone = zones[to];
      if (toZone === undefined || toZone === fromZone) continue;
      for (const edge of inputEdgeNames(program.nodes[to]!.input)) {
        if (!produced.has(edge)) continue;
        const def = (program.edges ?? {})[edge];
        found.push({ from, to, edge, fromZone, toZone, carries: def === undefined ? [] : classificationsOf(def) });
      }
    }
  }
  return found.sort((a, b) => a.from.localeCompare(b.from) || a.edge.localeCompare(b.edge));
}
