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
  label: string;
  description: string;
  measure?: Measure;
  format?: Format;
  unit?: string;
  enumValues?: string[];
  relation?: Relation;
  validations?: Validation<T>;
  /** Original field name in an upstream source, where this edge is derived from one. */
  sourceKey?: string;
}

type NumberValidation = { 
  min?: number;
  max?: number;
}
  
type StringValidation = {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

type Validation<T extends ScalarType> = T extends "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "f32" | "f64"
? NumberValidation
: T extends "utf8"
  ? StringValidation
  : never;



/** An edge definition: name, optional index field, and field map. */
export interface EdgeDef<F extends Record<string, FieldDef | AnyEdgeDef> = Record<string, FieldDef>> {
  name: string;
  description: string;
  /** Field that uniquely identifies an instance, where one exists. */
  index?: string;
  fields: F;
}

/**
 * An EdgeDef whose fields may include compound (nested-edge) fields, not just
 * scalars, at any nesting depth — self-referential on purpose, so a compound
 * field's own fields can themselves contain compound fields. A bare `EdgeDef`
 * (no type argument) resolves to `EdgeDef`'s narrow default
 * (`Record<string, FieldDef>`), not its wider constraint — so anywhere a
 * generic bound needs to admit a compound edge, it must say so with this
 * alias rather than writing `EdgeDef` bare.
 */
export type AnyEdgeDef = EdgeDef<Record<string, FieldDef | AnyEdgeDef>>;

/**
 * The unit edge — the only special edge (docs/design.md §5). An origin
 * node's input is Unit rather than `null`, so origins aren't a schema-level
 * special case: every node's input is a real, named edge.
 */
export const Unit: EdgeDef<Record<string, never>> = {
  name: "Unit",
  description: "The unit edge — an origin node's input, carrying no data.",
  fields: {},
};

/** Maps a scalar edge type to the TypeScript type its instances carry. */
export type ScalarTsType<T extends ScalarType> = T extends "utf8"
  ? string
  : T extends "bool"
    ? boolean
    : number;

/**
 * The runtime payload shape produced by a field map. A field is either a
 * scalar (FieldDef) or a compound, nested edge (EdgeDef) — the recursive
 * case computes that nested edge's own payload shape the same way.
 */
export type Payload<F extends Record<string, FieldDef | AnyEdgeDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T>
    ? ScalarTsType<T>
    : F[K] extends AnyEdgeDef
      ? PayloadOf<F[K]>
      : never;
};

/** The runtime payload shape of an edge definition. */
export type PayloadOf<E extends AnyEdgeDef> = Payload<E["fields"]>;

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
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "oneOf"; edges: AnyEdgeDef[] }
  | { kind: "allOf"; edges: AnyEdgeDef[] }
  | { kind: "many"; edge: AnyEdgeDef };

/** One branch of a oneOf/allOf result: which edge fired, and its payload. */
type Tagged<E extends AnyEdgeDef> = { edge: E["name"]; payload: PayloadOf<E> };

/** The value a node's Fn must return, given its declared OutputSpec. */
export type OutputResult<O extends OutputSpec> = O extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : O extends { kind: "oneOf"; edges: infer Es extends AnyEdgeDef[] }
    ? { [I in keyof Es]: Es[I] extends AnyEdgeDef ? Tagged<Es[I]> : never }[number]
    : O extends { kind: "allOf"; edges: infer Es extends AnyEdgeDef[] }
      ? { [I in keyof Es]: Es[I] extends AnyEdgeDef ? Tagged<Es[I]> : never }
      : O extends { kind: "many"; edge: infer E extends AnyEdgeDef }
        ? PayloadOf<E>[]
        : never;

/**
 * A node's implementation. Context-free by default; a second `env`
 * parameter opts a node into seeing the envelope (docs/design.md §1). Not
 * a string reference — see spikes/ts-prototype/README.md for why a spike
 * represents "Fn reference" as a real typed function.
 */
export type Fn<In extends AnyEdgeDef, O extends OutputSpec> = (
  payload: PayloadOf<In>,
  env?: Envelope,
) => OutputResult<O> | Promise<OutputResult<O>>;

/**
 * A single example in composition syntax, structurally: given -> expect
 * (docs/design.md §6). Composition-syntax parsing doesn't exist yet
 * (getting-started.md step 3); this is the typed equivalent.
 */
export interface Example<In extends AnyEdgeDef, O extends OutputSpec> {
  given: PayloadOf<In>;
  expect: OutputResult<O>;
}

/**
 * A node declaration: name, input edge, output shape, Fn, and examples
 * (docs/getting-started.md step 2). Primitives only — a composite node's
 * body is a subgraph, which has no representation yet (topology/elaborator
 * are steps 3-4).
 */
export interface NodeDef<In extends AnyEdgeDef = AnyEdgeDef, O extends OutputSpec = OutputSpec> {
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

type ExpectClosure<In extends AnyEdgeDef> = { expected: PayloadOf<In> };
type LiteralClosure<O extends OutputSpec> = { literal: OutputResult<O> };
