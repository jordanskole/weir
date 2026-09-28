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
}

type Zoned = {
  nodes: Record<string, NodeDecl>;
  wiring: Wiring;
  topologies: CompositeDecl[];
  declaredIn: Record<string, string>;
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
        if (produced.has(edge)) found.push({ from, to, edge, fromZone, toZone });
      }
    }
  }
  return found.sort((a, b) => a.from.localeCompare(b.from) || a.edge.localeCompare(b.edge));
}
