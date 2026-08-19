/**
 * Identity functions for type-safe edge definitions.
 *
 * These exist solely for TypeScript inference — they return their input unchanged
 * but constrain the type so that literal types (e.g. "uint8") are preserved.
 * Pattern stolen from @bankql/schema's defineField/defineDataset.
 */

import type { EdgeDef, FieldDef, ScalarType } from "./types.js";

/** Define a single field with rich metadata. Returns the input unchanged. */
export function defineField<T extends ScalarType>(field: FieldDef<T>): FieldDef<T> {
  return field;
}

/** Define an edge with typed fields. Returns the input unchanged. */
export function defineEdge<F extends Record<string, FieldDef>>(edge: EdgeDef<F>): EdgeDef<F> {
  return edge;
}
