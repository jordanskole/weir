/**
 * Serializes an elaborated program (`elaborate.ts`'s `Elaborated`) into the
 * netlist JSON shape docs/getting-started.md step 4 asks for — edges (with
 * schema hashes), nodes (contract only, edge object references flattened
 * back to the bare names / tagged shapes `.node` YAML uses), and topology
 * (instances/wires). Deliberately excludes `trace` — that's a single run's
 * log, not something elaboration produces (examples/person-birthday/README.md,
 * decision 1: "netlist vs. trace are two different things").
 *
 * Instance ids are synthesized as `${nodeName}#1` — `Wiring` (elaborate.ts)
 * is node-name-keyed and can't yet represent two instances of the same node
 * within one topology, so this doesn't introduce a new limitation, just
 * makes the existing one visible in the output shape (see
 * examples/person-birthday/README.md, "Instance identity is `node-name#n`").
 */

import type { Elaborated, Wiring } from "./elaborate.js";
import { hashEdge } from "./hash.js";
import type { AnyEdgeDef, FieldDef, InputSpec, ManyEdgeDef, NodeDecl, OutputSpec } from "./types.js";

export type NetlistField = FieldDef | { edge: string } | { many: string };

export interface NetlistEdge {
  fields: Record<string, NetlistField>;
  schemaHash: string;
}

export type NetlistInputSpec = string | { allOf: string[] };
export type NetlistOutputSpec = string | { oneOf: string[] } | { allOf: string[] } | { many: string };

export interface NetlistNode {
  input: NetlistInputSpec;
  output: NetlistOutputSpec;
  label?: string;
  description?: string;
  closure?: unknown;
  examples?: unknown;
  scope?: string[];
}

export interface NetlistTopology {
  origins: string[];
  instances: Record<string, { node: string }>;
  wires: { from: string; to: string }[];
}

export interface Netlist {
  edges: Record<string, NetlistEdge>;
  nodes: Record<string, NetlistNode>;
  topology: NetlistTopology;
}

/**
 * Flattens a compound/many field to a name reference rather than embedding
 * the referenced edge's structure again — it already gets its own top-level
 * entry in `Netlist.edges`. Assumes that entry exists: `elaborate()` always
 * registers every edge it resolves a reference against, so this holds for
 * any `Elaborated` it produces, but a hand-built one that omits a referenced
 * edge would produce a dangling reference here.
 */
function serializeField(value: FieldDef | AnyEdgeDef | ManyEdgeDef): NetlistField {
  if ("many" in value) return { many: value.many.name };
  if ("fields" in value) return { edge: value.name };
  return value;
}

function serializeEdge(edge: AnyEdgeDef, schemaHash: string): NetlistEdge {
  const fields: Record<string, NetlistField> = {};
  for (const [key, value] of Object.entries(edge.fields)) {
    fields[key] = serializeField(value);
  }
  return { fields, schemaHash };
}

async function serializeEdges(edges: Record<string, AnyEdgeDef>): Promise<Record<string, NetlistEdge>> {
  const entries = await Promise.all(
    Object.entries(edges).map(async ([name, edge]) => {
      const { short } = await hashEdge(edge);
      return [name, serializeEdge(edge, short)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function serializeInput(input: InputSpec): NetlistInputSpec {
  if (input.kind === "single") return input.edge.name;
  return { allOf: input.edges.map((edge) => edge.name) };
}

function serializeOutput(output: OutputSpec): NetlistOutputSpec {
  if (output.kind === "single") return output.edge.name;
  if (output.kind === "many") return { many: output.edge.name };
  if (output.kind === "oneOf") return { oneOf: output.edges.map((edge) => edge.name) };
  return { allOf: output.edges.map((edge) => edge.name) };
}

function serializeNode(node: NodeDecl): NetlistNode {
  return {
    input: serializeInput(node.input),
    output: serializeOutput(node.output),
    ...(node.label !== undefined && { label: node.label }),
    ...(node.description !== undefined && { description: node.description }),
    ...(node.closure !== undefined && { closure: node.closure }),
    ...(node.examples !== undefined && { examples: node.examples }),
    ...(node.scope !== undefined && { scope: node.scope }),
  };
}

function serializeNodes(nodes: Record<string, NodeDecl>): Record<string, NetlistNode> {
  const result: Record<string, NetlistNode> = {};
  for (const [name, node] of Object.entries(nodes)) {
    result[name] = serializeNode(node);
  }
  return result;
}

function instanceId(nodeName: string): string {
  return `${nodeName}#1`;
}

function serializeTopology(wiring: Wiring): NetlistTopology {
  const nodeNames = new Set<string>(wiring.origins);
  for (const [parent, children] of Object.entries(wiring.feeds)) {
    nodeNames.add(parent);
    for (const child of children) nodeNames.add(child);
  }

  const instances: Record<string, { node: string }> = {};
  for (const name of nodeNames) {
    instances[instanceId(name)] = { node: name };
  }

  const wires: { from: string; to: string }[] = [];
  for (const [parent, children] of Object.entries(wiring.feeds)) {
    for (const child of children) {
      wires.push({ from: instanceId(parent), to: instanceId(child) });
    }
  }

  return { origins: wiring.origins.map(instanceId), instances, wires };
}

/** Serializes an `Elaborated` program into the netlist JSON shape (see module header). */
export async function serializeNetlist(elaborated: Elaborated): Promise<Netlist> {
  return {
    edges: await serializeEdges(elaborated.edges),
    nodes: serializeNodes(elaborated.nodes),
    topology: serializeTopology(elaborated.wiring),
  };
}
