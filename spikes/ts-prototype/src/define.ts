/**
 * Identity functions for type-safe edge and node definitions.
 *
 * These exist solely for TypeScript inference — they return their input unchanged
 * but constrain the type so that literal types (e.g. "uint8") are preserved.
 * defineField/defineEdge are stolen from @bankql/schema's defineField/defineDataset;
 * defineNode follows the same trick for node declarations (docs/getting-started.md
 * step 2).
 */

import type {
  AnyEdgeDef,
  EdgeDef,
  FieldDef,
  ManyEdgeDef,
  NodeDef,
  OutputSpec,
  ScalarType,
} from "./types.js";

/** uint8/16/32 are the unsigned integer types — min may not go negative. */
export const UNSIGNED_TYPES: ScalarType[] = ["uint8", "uint16", "uint32"];

/**
 * Representable [min, max] for integer scalar types. f32/f64 are unbounded
 * here on purpose. Exported so schema.ts's JSON Schema generator can encode
 * the exact same bounds rather than duplicating these numbers.
 */
export const INTEGER_RANGES: Partial<Record<ScalarType, [number, number]>> = {
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
};

interface NumberValidationShape {
  min?: number;
  max?: number;
}

interface StringValidationShape {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

/**
 * `field: FieldDef` erases the generic T, so `field.validations`'s static type is a
 * union of every scalar type's validation shape. Runtime type-appropriateness checks
 * below (wrong shape for this field's type) are what a plain object literal — the
 * eventual .field/.edge YAML case, which bypasses TS entirely — still needs; these
 * casts just tell the compiler what's already been confirmed at runtime.
 */
function validateNumericConstraints(field: FieldDef): void {
  const v = field.validations as NumberValidationShape | undefined;
  if (v === undefined) return;

  if (v.min !== undefined && UNSIGNED_TYPES.includes(field.type) && v.min < 0) {
    throw new Error(`Field of type "${field.type}" cannot have a negative min (got ${v.min}).`);
  }
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
    throw new Error(`min (${v.min}) must be <= max (${v.max}) on field of type "${field.type}".`);
  }

  const range = INTEGER_RANGES[field.type];
  if (range === undefined) return; // f32/f64: no representable-range or integer check

  const [rangeMin, rangeMax] = range;
  if (v.min !== undefined && v.min < rangeMin) {
    throw new Error(
      `min (${v.min}) is outside the representable range of "${field.type}" [${rangeMin}, ${rangeMax}].`,
    );
  }
  if (v.max !== undefined && v.max > rangeMax) {
    throw new Error(
      `max (${v.max}) is outside the representable range of "${field.type}" [${rangeMin}, ${rangeMax}].`,
    );
  }
  if (v.min !== undefined && !Number.isInteger(v.min)) {
    throw new Error(`min (${v.min}) must be an integer on field of type "${field.type}".`);
  }
  if (v.max !== undefined && !Number.isInteger(v.max)) {
    throw new Error(`max (${v.max}) must be an integer on field of type "${field.type}".`);
  }
}

function validateStringConstraints(field: FieldDef): void {
  const v = field.validations as StringValidationShape | undefined;

  if (v !== undefined) {
    if (v.minLength !== undefined && v.minLength < 0) {
      throw new Error(`minLength (${v.minLength}) cannot be negative.`);
    }
    if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
      throw new Error(`minLength (${v.minLength}) must be <= maxLength (${v.maxLength}).`);
    }
    if (v.pattern !== undefined) {
      try {
        new RegExp(v.pattern);
      } catch {
        throw new Error(`pattern "${v.pattern}" is not a valid regex.`);
      }
    }
  }

  if (field.enumValues !== undefined) {
    if (v?.pattern !== undefined || v?.minLength !== undefined || v?.maxLength !== undefined) {
      throw new Error(
        `enumValues already fully determines the domain; it cannot combine with pattern/minLength/maxLength.`,
      );
    }
  }
}

function validateField(field: FieldDef): void {
  const isString = field.type === "utf8" || field.type === "datetime";
  const isNumeric = !isString && field.type !== "bool";
  const v = field.validations as (NumberValidationShape & StringValidationShape) | undefined;

  if (v !== undefined && (v.minLength !== undefined || v.maxLength !== undefined) && !isString) {
    throw new Error(`Field of type "${field.type}" cannot declare minLength/maxLength; that's for utf8 fields.`);
  }
  if (v !== undefined && v.pattern !== undefined && !isString) {
    throw new Error(`Field of type "${field.type}" cannot declare pattern; that's for utf8 fields.`);
  }
  if (field.enumValues !== undefined && !isString) {
    throw new Error(`Field of type "${field.type}" cannot declare enumValues; that's for utf8 fields.`);
  }
  if (v !== undefined && (v.min !== undefined || v.max !== undefined) && !isNumeric) {
    throw new Error(`Field of type "${field.type}" cannot declare min/max; that's for numeric fields.`);
  }

  const rawNullable = (field as { nullable?: unknown }).nullable;
  if (field.type === "bool") {
    if (rawNullable !== undefined) {
      throw new Error(
        `Field of type "bool" cannot declare nullable — a nullable boolean is a tri-state in disguise (true/false/null), not a real type.`,
      );
    }
  } else if (typeof rawNullable !== "boolean") {
    throw new Error(
      `Field of type "${field.type}" must declare nullable (true or false) — it's required, not optional.`,
    );
  }

  if (isNumeric) validateNumericConstraints(field);
  if (isString) validateStringConstraints(field);
}

/** Define a single field with rich metadata. Returns the input unchanged. */
export function defineField<T extends ScalarType, N extends boolean = false>(
  field: FieldDef<T, N>,
): FieldDef<T, N> {
  validateField(field);
  return field;
}

/** Define an edge with typed fields. Returns the input unchanged. */
export function defineEdge<F extends Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef>>(
  edge: EdgeDef<F>,
): EdgeDef<F> {
  return edge;
}

/** Define a node: name, input edge, output shape, Fn, examples. Returns the input unchanged. */
export function defineNode<In extends AnyEdgeDef, O extends OutputSpec>(
  node: NodeDef<In, O>,
): NodeDef<In, O> {
  return node;
}

/** Rhombus: one edge in, the same edge out (docs/design.md §2). */
export function single<E extends AnyEdgeDef>(edge: E): { kind: "single"; edge: E } {
  return { kind: "single", edge };
}

/** Coproduct: exactly one of the listed edges fires, chosen by value. */
export function oneOf<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "oneOf"; edges: Es } {
  return { kind: "oneOf", edges };
}

/** Product (fission): every listed edge fires. */
export function allOf<Es extends AnyEdgeDef[]>(...edges: Es): { kind: "allOf"; edges: Es } {
  return { kind: "allOf", edges };
}

/** Cardinality: N instances of one edge. */
export function many<E extends AnyEdgeDef>(edge: E): { kind: "many"; edge: E } {
  return { kind: "many", edge };
}
