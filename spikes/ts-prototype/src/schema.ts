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
];

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
 * The part of a field's shape that's identical whether it's a standalone
 * `.field` file (which also self-declares `name`) or an inline field value
 * inside an `.edge` file's `fields` map (which doesn't — the map key already
 * is the name, so `name` is deliberately absent, not just optional, here).
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
    if: { properties: { type: { const: "utf8" } } },
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
  };

  return { properties, allOf };
}

/** Generates a JSON Schema for a standalone `.field` file. */
export function fieldSchema(): object {
  const { properties, allOf } = fieldPropertiesSchema();
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir field",
    type: "object",
    required: ["name", "type", "label", "description"],
    properties: { name: { type: "string" }, ...properties },
    additionalProperties: false,
    allOf,
  };
}

/** An inline field value inside an `.edge` file's `fields` map — same shape, no `name`. */
function inlineFieldSchema(): object {
  const { properties, allOf } = fieldPropertiesSchema();
  return {
    type: "object",
    required: ["type", "label", "description"],
    properties,
    additionalProperties: false,
    allOf,
  };
}

/** Generates a JSON Schema for a `.edge` file. */
export function edgeSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir edge",
    type: "object",
    required: ["name", "description", "fields"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      index: { type: "string" },
      fields: {
        type: "object",
        additionalProperties: {
          oneOf: [{ type: "string", minLength: 1 }, inlineFieldSchema()],
        },
      },
    },
    additionalProperties: false,
  };
}

const edgeName = { type: "string", minLength: 1 };
const edgeNameList = { type: "array", items: edgeName, minItems: 1 };

/**
 * Generates a JSON Schema for a `.node` file — the contract only, per §10:
 * no `fn`, name/input/output/examples/closure. `input`/`output` reference
 * edges by bare name, resolved elsewhere (by the elaborator, not this
 * schema). `given`/`expect`/`expected`/`literal` payloads are deliberately
 * unconstrained here — matching them against the shape the referenced edge
 * actually declares needs cross-file information a static schema doesn't
 * have; that's the elaborator's/generator's job (§6), not this one's.
 */
export function nodeSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir node",
    type: "object",
    required: ["name", "input", "output"],
    properties: {
      name: { type: "string" },
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
        items: {
          type: "object",
          required: ["given", "expect"],
          properties: { given: {}, expect: {} },
          additionalProperties: false,
        },
      },
      closure: {
        oneOf: [
          {
            type: "object",
            properties: { expected: {} },
            required: ["expected"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { literal: {} },
            required: ["literal"],
            additionalProperties: false,
          },
        ],
      },
    },
    additionalProperties: false,
  };
}
