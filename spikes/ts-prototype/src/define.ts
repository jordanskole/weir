/**
 * Identity functions for type-safe edge and node definitions.
 *
 * These exist solely for TypeScript inference — they return their input unchanged
 * but constrain the type so that literal types (e.g. "uint8") are preserved.
 * defineField/defineEdge are stolen from @bankql/schema's defineField/defineDataset;
 * defineNode follows the same trick for node declarations (docs/getting-started.md
 * step 2).
 */

import type { EdgeDef, FieldDef, NodeDef, OutputSpec, ScalarType } from "./types.js";

/** Define a single field with rich metadata. Returns the input unchanged. */
export function defineField<T extends ScalarType>(field: FieldDef<T>): FieldDef<T> {
  return field;
}

/** Define an edge with typed fields. Returns the input unchanged. */
export function defineEdge<F extends Record<string, FieldDef>>(edge: EdgeDef<F>): EdgeDef<F> {
  return edge;
}

/** Define a node: name, input edge, output shape, Fn, examples. Returns the input unchanged. */
export function defineNode<In extends EdgeDef, O extends OutputSpec>(
  node: NodeDef<In, O>,
): NodeDef<In, O> {
  return node;
}

/** Rhombus: one edge in, the same edge out (docs/design.md §2). */
export function single<E extends EdgeDef>(edge: E): { kind: "single"; edge: E } {
  return { kind: "single", edge };
}

/** Coproduct: exactly one of the listed edges fires, chosen by value. */
export function oneOf<Es extends EdgeDef[]>(...edges: Es): { kind: "oneOf"; edges: Es } {
  return { kind: "oneOf", edges };
}

/** Product (fission): every listed edge fires. */
export function allOf<Es extends EdgeDef[]>(...edges: Es): { kind: "allOf"; edges: Es } {
  return { kind: "allOf", edges };
}

/** Cardinality: N instances of one edge. */
export function many<E extends EdgeDef>(edge: E): { kind: "many"; edge: E } {
  return { kind: "many", edge };
}
