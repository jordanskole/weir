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
