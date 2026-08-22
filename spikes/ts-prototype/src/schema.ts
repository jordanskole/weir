/**
 * JSON Schema generation for `.field`/`.edge` YAML — the "schema-driven
 * editor support" docs/design.md §10 promises, generated mechanically from
 * the same types (and the same INTEGER_RANGES table) that already validate
 * everything else via defineField. Consumed by VS Code's YAML tooling
 * (redhat.vscode-yaml / yaml-language-server), not by weir's own runtime.
 *
 * What this can't express: cross-field relationships (min <= max,
 * enumValues excluding pattern/minLength/maxLength) — standard JSON Schema
 * has no clean way to compare sibling properties. Those checks still only
 * run for real in defineField/elaborate(); this schema catches the shape
 * mistakes a human makes while typing, not every rule.
 */

import { INTEGER_RANGES, UNSIGNED_TYPES } from "./define.js";
import type { ScalarType } from "./types.js";

const SCALAR_TYPES: ScalarType[] = [
  "utf8",
  "bool",
  "uint8",
  "uint16",
  "uint32",
  "int8",
  "int16",
  "int32",
  "f32",
  "f64",
  "datetime",
];

/** String-shaped types — pattern/minLength/maxLength validations, no min/max. */
const STRING_TYPES: ScalarType[] = ["utf8", "datetime"];

const INTEGER_TYPES = Object.keys(INTEGER_RANGES) as ScalarType[];
const FLOAT_TYPES: ScalarType[] = ["f32", "f64"];

/** The `validations` sub-schema for a numeric field of the given [min, max] bound. */
function numberValidationSchema(bound: Record<string, unknown>): object {
  return {
    type: "object",
    properties: { min: bound, max: bound },
    additionalProperties: false,
  };
}

/**
 * The type-appropriate `validations` shape and the rest of a field's
 * properties — shared by `fieldShape()` (a standalone `.field` file or an
 * inline field value; the two are identical, see `fieldShape()`).
 */
function fieldPropertiesSchema(): { properties: Record<string, object>; allOf: object[] } {
  const allOf: object[] = [];

  for (const type of INTEGER_TYPES) {
    const [lo, hi] = INTEGER_RANGES[type]!;
    const minimum = UNSIGNED_TYPES.includes(type) ? Math.max(0, lo) : lo;
    allOf.push({
      if: { properties: { type: { const: type } } },
      then: {
        properties: {
          validations: numberValidationSchema({ type: "integer", minimum, maximum: hi }),
        },
      },
    });
  }

  allOf.push({
    if: { properties: { type: { enum: FLOAT_TYPES } } },
    then: {
      properties: { validations: numberValidationSchema({ type: "number" }) },
    },
  });

  allOf.push({
    if: { properties: { type: { enum: STRING_TYPES } } },
    then: {
      properties: {
        validations: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            minLength: { type: "integer", minimum: 0 },
            maxLength: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
    else: {
      not: { required: ["enumValues"] },
    },
  });

  allOf.push({
    if: { properties: { type: { const: "bool" } } },
    then: { not: { required: ["validations"] } },
  });

  // nullable is required for every type except bool, where a nullable boolean
  // would be a tri-state in disguise — disallowed outright, not just optional.
  allOf.push({
    if: { properties: { type: { const: "bool" } } },
    then: { not: { required: ["nullable"] } },
    else: { required: ["nullable"] },
  });

  const properties: Record<string, object> = {
    type: { enum: SCALAR_TYPES },
    label: { type: "string" },
    description: { type: "string" },
    measure: { enum: ["nominal", "ordinal", "quantitative", "temporal"] },
    format: {
      enum: ["id", "enum", "text", "date", "datetime", "count", "percentage"],
    },
    unit: { type: "string" },
    enumValues: { type: "array", items: { type: "string" } },
    sourceKey: { type: "string" },
    relation: {
      type: "object",
      required: ["edge", "field", "cardinality"],
      properties: {
        edge: { type: "string" },
        field: { type: "string" },
        cardinality: { enum: ["1:1", "1:many", "many:1", "many:many"] },
      },
      additionalProperties: false,
    },
    validations: { type: "object" },
    nullable: { type: "boolean" },
  };

  return { properties, allOf };
}

/**
 * The bare shape of a field — a standalone `.field` file's content, and,
 * structurally identical, an inline field value inside an `.edge` file's
 * `fields` map. Neither declares `name`: a standalone file's name is its
 * filename, an inline field's name is its key in the parent `fields` map —
 * the same information source in both cases, so there's no second place for
 * it to live and no way for it to drift out of sync with the thing it names.
 * No `$schema`/`title` here — those belong only at a schema document's root,
 * never on a subschema nested inside another (as this shape is, from
 * `edgeSchema()`).
 */
function fieldShape(): object {
  const { properties, allOf } = fieldPropertiesSchema();
  return {
    type: "object",
    required: ["type", "label", "description"],
    properties,
    additionalProperties: false,
    allOf,
  };
}

/** Generates a JSON Schema for a standalone `.field` file. */
export function fieldSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir field",
    ...fieldShape(),
  };
}

/** Generates a JSON Schema for a `.edge` file. */
export function edgeSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir edge",
    type: "object",
    required: ["label", "description", "fields"],
    properties: {
      label: { type: "string" },
      description: { type: "string" },
      index: { type: "string" },
      fields: {
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string", minLength: 1 },
            fieldShape(),
            {
              type: "object",
              required: ["many"],
              properties: { many: { type: "string", minLength: 1 } },
              additionalProperties: false,
            },
          ],
        },
      },
    },
    additionalProperties: false,
  };
}

const edgeName = { type: "string", minLength: 1 };
const edgeNameList = { type: "array", items: edgeName, minItems: 1 };

/**
 * A "tagged" payload: exactly one key (the edge's name — a field's key in an
 * `.edge` map or, here, the sole property of an example), whose value must
 * match `valueSchema`. The tag's *name* is never checked against a real
 * declared edge — that needs cross-file information (or, for `oneOf`/`allOf`/
 * `many`, the sibling `output`'s own declared names) that standard JSON
 * Schema can't reach without `$data`, confirmed unreliable rather than
 * assumed (ajv's `$data` silently accepted an invalid tag in testing). Real
 * name-matching stays the elaborator's job once `.node` loading exists.
 */
function tagged(valueSchema: object): object {
  return { type: "object", minProperties: 1, additionalProperties: valueSchema };
}

/** Like `tagged`, but exactly one tag — for shapes where more than one never makes sense. */
function taggedOne(valueSchema: object): object {
  return { ...tagged(valueSchema), maxProperties: 1 };
}

/**
 * Generates a JSON Schema for a `.node` file — the contract only, per §10:
 * no `fn`, name/input/output/examples/closure. `input`/`output` reference
 * edges by bare name, resolved elsewhere (by the elaborator, not this
 * schema). `examples` is required and non-empty — per §6, examples are the
 * only thing that gives a same-shape-in-same-shape-out node (a "straight
 * pipe": one edge in, one out — see docs/design-history.md) any actual
 * content beyond its type signature; a node with none is indistinguishable
 * from a no-op.
 */
export function nodeSchema(): object {
  const objectPayload = { type: "object" };
  const outputShapeConditionals = [
    // single (bare-string output) or oneOf: exactly one tag, payload is an object.
    {
      if: { properties: { output: { type: "string" } } },
      then: { properties: { examples: { items: { properties: { expect: taggedOne(objectPayload) } } } } },
    },
    {
      if: { properties: { output: { type: "object", required: ["oneOf"] } } },
      then: { properties: { examples: { items: { properties: { expect: taggedOne(objectPayload) } } } } },
    },
    // allOf: one or more tags fire together, each an object — can't check the
    // tag count matches output.allOf's length without $data (see `tagged`).
    {
      if: { properties: { output: { type: "object", required: ["allOf"] } } },
      then: { properties: { examples: { items: { properties: { expect: tagged(objectPayload) } } } } },
    },
    // many: exactly one tag, whose value is an array of payload objects.
    {
      if: { properties: { output: { type: "object", required: ["many"] } } },
      then: {
        properties: {
          examples: {
            items: {
              properties: { expect: taggedOne({ type: "array", items: objectPayload }) },
            },
          },
        },
      },
    },
  ];

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir node",
    type: "object",
    required: ["input", "output", "examples"],
    properties: {
      label: { type: "string" },
      description: { type: "string" },
      input: edgeName,
      output: {
        oneOf: [
          edgeName,
          {
            type: "object",
            properties: { oneOf: edgeNameList },
            required: ["oneOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { allOf: edgeNameList },
            required: ["allOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { many: edgeName },
            required: ["many"],
            additionalProperties: false,
          },
        ],
      },
      examples: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["given", "expect"],
          // given is always single-tagged: a node's input is always exactly
          // one edge (§10's "Left open" version-pin note aside — no
          // multi-input/join yet).
          properties: { given: taggedOne(objectPayload), expect: {} },
          additionalProperties: false,
        },
      },
      closure: {
        oneOf: [
          {
            type: "object",
            properties: { expected: taggedOne(objectPayload) },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: tagged({}) },
            required: ["literal"],
            additionalProperties: false,
          },
        ],
      },
    },
    additionalProperties: false,
    allOf: outputShapeConditionals,
  };
}
