/**
 * The sealed contract an isolated implementing agent receives for one node
 * — everything Fn must structurally satisfy (full input/output edge
 * shapes, description, examples, closure, and the Failed<In> shape it may
 * always return instead of output), and nothing else: no topology, no
 * sibling nodes, no design rationale for why the ontology is shaped this
 * way (docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md).
 */

import { serializeField, type NetlistField } from "./netlist.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

export interface ContractEdgeShape {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: Record<string, NetlistField>;
}

export type ContractInputSpec = ContractEdgeShape | { allOf: ContractEdgeShape[] };

export type ContractOutputSpec =
  | ContractEdgeShape
  | { oneOf: ContractEdgeShape[] }
  | { allOf: ContractEdgeShape[] }
  | { many: ContractEdgeShape };

export interface SealedContract {
  node: string;
  input: ContractInputSpec;
  output: ContractOutputSpec;
  description?: string;
  examples?: NodeDecl["examples"];
  closure?: NodeDecl["closure"];
  /** Fn may always return this instead of `output` — Failed<In>'s real shape, docs/design.md §3. */
  failure: { input: ContractInputSpec; reason?: string };
}

function edgeShape(edge: AnyEdgeDef): ContractEdgeShape {
  const fields: Record<string, NetlistField> = {};
  for (const [key, value] of Object.entries(edge.fields)) {
    fields[key] = serializeField(value);
  }
  return {
    name: edge.name,
    label: edge.label,
    description: edge.description,
    ...(edge.index !== undefined && { index: edge.index }),
    fields,
  };
}

function contractInputSpec(input: NodeDecl["input"]): ContractInputSpec {
  if (input.kind === "single") return edgeShape(input.edge);
  return { allOf: input.edges.map(edgeShape) };
}

function contractOutputSpec(output: NodeDecl["output"]): ContractOutputSpec {
  if (output.kind === "single") return edgeShape(output.edge);
  if (output.kind === "many") return { many: edgeShape(output.edge) };
  if (output.kind === "oneOf") return { oneOf: output.edges.map(edgeShape) };
  return { allOf: output.edges.map(edgeShape) };
}

export function exportContract(node: NodeDecl): SealedContract {
  return {
    node: node.name,
    input: contractInputSpec(node.input),
    output: contractOutputSpec(node.output),
    ...(node.description !== undefined && { description: node.description }),
    ...(node.examples !== undefined && { examples: node.examples }),
    ...(node.closure !== undefined && { closure: node.closure }),
    failure: { input: contractInputSpec(node.input) },
  };
}
