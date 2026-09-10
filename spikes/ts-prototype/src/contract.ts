/**
 * The sealed contract an isolated implementing agent receives for one node
 * — everything Fn must structurally satisfy (full input/output edge
 * shapes, description, examples, closure, and the Failed<In> shape it may
 * always return instead of output), and nothing else: no topology, no
 * sibling nodes, no design rationale for why the ontology is shaped this
 * way (docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md).
 *
 * `scope`'s presence is what tells an isolated agent to write `Fn(payload,
 * env)` rather than `Fn(payload)` — a node declaring `scope` expects the
 * second `env` parameter and reads the narrowed `Envelope.identity` claims
 * its scope names from it.
 */

import { serializeField, type NetlistField } from "./netlist.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

/**
 * A field as it appears inside a sealed contract. Unlike `NetlistField`, a
 * compound or `many`-of-compound field embeds the referenced edge's full
 * shape rather than its bare name: a `SealedContract` carries no top-level
 * edge registry to resolve a name against, and a `many` field's payload is
 * keyed by the referenced edge's own declared `index` (`types.ts`'s
 * `Payload`), which an agent cannot construct without seeing that edge's
 * fields.
 */
export type ContractField = NetlistField | ContractEdgeShape | { many: ContractEdgeShape };

export interface ContractEdgeShape {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: Record<string, ContractField>;
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
  /** Present iff the node declares one — its presence means Fn takes `(payload, env)`. */
  scope?: NodeDecl["scope"];
  /** Fn may always return this instead of `output` — Failed<In>'s real shape, docs/design.md §3. */
  failure: { input: ContractInputSpec; reason?: string };
}

/**
 * Recurses into compound and `many` fields so nested edges are embedded in
 * full, delegating to `netlist.ts`'s `serializeField` only for the
 * scalar/literal leaf case. Assumes edge definitions are acyclic and adds
 * no cycle guard — the same assumption `hash.ts`'s `fingerprint` already
 * makes, recursing through nested edges the identical way.
 */
function edgeShape(edge: AnyEdgeDef): ContractEdgeShape {
  const fields: Record<string, ContractField> = {};
  for (const [key, value] of Object.entries(edge.fields)) {
    if ("many" in value) {
      fields[key] = { many: edgeShape(value.many) };
    } else if ("fields" in value) {
      fields[key] = edgeShape(value);
    } else {
      fields[key] = serializeField(value);
    }
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
    ...(node.scope !== undefined && { scope: node.scope }),
    failure: { input: contractInputSpec(node.input) },
  };
}
