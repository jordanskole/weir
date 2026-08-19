/**
 * Core types for edge definitions.
 *
 * An edge is a named schema — the shape of what crosses a wire between nodes.
 * Compatibility between edges is structural (see docs/design.md §2); a name
 * exists so that refinement (two edges with identical shape but distinct
 * meaning, e.g. PersonReceived vs. PersonValidated) can be expressed when a
 * decision needs to survive into the next node's type.
 */

/** Scalar field types. */
export type ScalarType =
  | "utf8"
  | "bool"
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "f32"
  | "f64";

/** Statistical measure classification for a field. */
export type Measure = "nominal" | "ordinal" | "quantitative" | "temporal";

/** Display format hint for consumers (UI, exports, LLM, agent tool specs). */
export type Format = "id" | "enum" | "text" | "date" | "datetime" | "count" | "percentage";

/** Relationship cardinality between two edges. */
export type Cardinality = "1:1" | "1:many" | "many:1" | "many:many";

/** A reference from one edge's field to another edge. */
export interface Relation {
  edge: string;
  field: string;
  cardinality: Cardinality;
}

/** Rich metadata for a single field on an edge. */
export interface FieldDef<T extends ScalarType = ScalarType> {
  type: T;
  label?: string;
  description?: string;
  measure?: Measure;
  format?: Format;
  unit?: string;
  enumValues?: string[];
  relation?: Relation;
  /** Original field name in an upstream source, where this edge is derived from one. */
  sourceKey?: string;
}

/** An edge definition: name, optional index field, and field map. */
export interface EdgeDef<F extends Record<string, FieldDef> = Record<string, FieldDef>> {
  name: string;
  description?: string;
  /** Field that uniquely identifies an instance, where one exists. */
  index?: string;
  fields: F;
}

/**
 * The unit edge — the only special edge (docs/design.md §5). An origin
 * node's input is Unit rather than `null`, so origins aren't a schema-level
 * special case: every node's input is a real, named edge.
 */
export const Unit: EdgeDef<Record<string, never>> = {
  name: "Unit",
  fields: {},
};

/** Maps a scalar edge type to the TypeScript type its instances carry. */
export type ScalarTsType<T extends ScalarType> = T extends "utf8"
  ? string
  : T extends "bool"
    ? boolean
    : number;

/** The runtime payload shape produced by a field map. */
export type Payload<F extends Record<string, FieldDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T> ? ScalarTsType<T> : never;
};

/** The runtime payload shape of an edge definition. */
export type PayloadOf<E extends EdgeDef> = Payload<E["fields"]>;

/**
 * The principal an invocation runs as — the "on behalf of" (docs/design-history.md,
 * "Identity is the actor, edges are the resource"). Every invocation has one, even a
 * system/scheduler-triggered one; there is no identity-less execution. Placeholder
 * shape until the actor model is designed — `Unit`'s idiom, not `{}` (which types
 * as "any non-nullish value", not "empty object").
 */
export type Identity = Record<string, never>;

/**
 * Per-invocation metadata wrapping every edge instance (docs/design.md §1).
 * A node's Fn does not see this by default; a second `env` parameter is
 * what opts a node into being context-dependent (routers, dedupers).
 */
export interface Envelope {
  id: string;
  correlationId: string;
  causationId: string | null;
  timestamp: string;
  step: number;
  identity: Identity;
  schemaHash: string;
}

/**
 * A node's output shape (docs/design.md §3) — the three fan-out modes plus
 * the plain single-edge case, kept as distinct kinds so they can't be
 * conflated the way Node-RED's "multiple outputs" was (see
 * docs/design-history.md, "Fan-out is three different things").
 */
export type OutputSpec =
  | { kind: "single"; edge: EdgeDef }
  | { kind: "oneOf"; edges: EdgeDef[] }
  | { kind: "allOf"; edges: EdgeDef[] }
  | { kind: "many"; edge: EdgeDef };

/** One branch of a oneOf/allOf result: which edge fired, and its payload. */
type Tagged<E extends EdgeDef> = { edge: E["name"]; payload: PayloadOf<E> };

/** The value a node's Fn must return, given its declared OutputSpec. */
export type OutputResult<O extends OutputSpec> = O extends {
  kind: "single";
  edge: infer E extends EdgeDef;
}
  ? PayloadOf<E>
  : O extends { kind: "oneOf"; edges: infer Es extends EdgeDef[] }
    ? { [I in keyof Es]: Es[I] extends EdgeDef ? Tagged<Es[I]> : never }[number]
    : O extends { kind: "allOf"; edges: infer Es extends EdgeDef[] }
      ? { [I in keyof Es]: Es[I] extends EdgeDef ? Tagged<Es[I]> : never }
      : O extends { kind: "many"; edge: infer E extends EdgeDef }
        ? PayloadOf<E>[]
        : never;

/**
 * A node's implementation. Context-free by default; a second `env`
 * parameter opts a node into seeing the envelope (docs/design.md §1). Not
 * a string reference — see spikes/ts-prototype/README.md for why a spike
 * represents "Fn reference" as a real typed function.
 */
export type Fn<In extends EdgeDef, O extends OutputSpec> = (
  payload: PayloadOf<In>,
  env?: Envelope,
) => OutputResult<O> | Promise<OutputResult<O>>;

/**
 * A single example in composition syntax, structurally: given -> expect
 * (docs/design.md §6). Composition-syntax parsing doesn't exist yet
 * (getting-started.md step 3); this is the typed equivalent.
 */
export interface Example<In extends EdgeDef, O extends OutputSpec> {
  given: PayloadOf<In>;
  expect: OutputResult<O>;
}

/**
 * A node declaration: name, input edge, output shape, Fn, and examples
 * (docs/getting-started.md step 2). Primitives only — a composite node's
 * body is a subgraph, which has no representation yet (topology/elaborator
 * are steps 3-4).
 */
export interface NodeDef<In extends EdgeDef = EdgeDef, O extends OutputSpec = OutputSpec> {
  name: string;
  description?: string;
  input: In;
  output: O;
  fn: Fn<In, O>;
  examples?: Example<In, O>[];
  /**
   * Parameters baked in at elaboration time, e.g. an origin's literal or
   * expect's expected value (docs/design-history.md, "Generics: elaboration
   * monomorphizes"; examples/person-birthday/README.md decision 4).
   */
  closure?: ExpectClosure<In> | LiteralClosure<O>;
}

type ExpectClosure<In extends EdgeDef> = { expected: PayloadOf<In> };
type LiteralClosure<O extends OutputSpec> = { literal: OutputResult<O> };
