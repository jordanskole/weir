/**
 * The membrane (docs/design.md §5) — the boundary every node invocation
 * passes through, generated purely from a node's own NodeDef. Not a
 * primitive a `.node` author declares or configures; there is nothing to
 * pass `membrane()` beyond the NodeDef itself.
 *
 * This is a first, deliberately narrow slice: assert a scalar-only input
 * payload, then call Fn. Not yet built: multi-input `every:` (NodeDef.input
 * is still a single edge), `scope`/identity resolution, correlation-id log
 * resolution (no store exists yet in this spike), compound/nested-edge and
 * `many` fields in the payload being asserted, and turning a rejection into
 * a Failed<In> edge rather than a thrown error (design.md §3). Each is its
 * own next increment.
 */

import type { AnyEdgeDef, FieldDef, NodeDef, OutputResult, OutputSpec, PayloadOf } from "./types.js";

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function typeofFor(field: FieldDef): "string" | "boolean" | "number" {
  if (field.type === "utf8" || field.type === "datetime") return "string";
  if (field.type === "bool") return "boolean";
  return "number";
}

/**
 * Asserts an unknown value against an edge's declared scalar fields,
 * collecting every violation rather than stopping at the first, so a caller
 * sees the whole shape of what's wrong at once.
 */
export function assertPayload<E extends AnyEdgeDef>(edge: E, payload: unknown): PayloadOf<E> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${edge.name}: expected an object, got ${describeType(payload)}.`);
  }

  const record = payload as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, fieldDef] of Object.entries(edge.fields)) {
    if ("fields" in fieldDef || "many" in fieldDef) {
      throw new Error(
        `${edge.name}.${key}: compound and many fields aren't asserted by the membrane yet.`,
      );
    }
    const field = fieldDef as FieldDef;
    const value = record[key];

    if (value === null) {
      if (!("nullable" in field && field.nullable === true)) {
        errors.push(`${key} is null, but this field isn't nullable`);
      }
      continue;
    }

    const expected = typeofFor(field);
    if (typeof value !== expected) {
      errors.push(`${key} should be ${expected}, got ${describeType(value)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`${edge.name}: ${errors.join("; ")}.`);
  }

  return record as PayloadOf<E>;
}

/**
 * Wraps a node's Fn so it can never run against an unasserted payload.
 * `membrane(nodeDef)` takes nothing but the declaration itself — the
 * returned function's behavior is entirely a product of what the NodeDef
 * says, never separately configured.
 */
export function membrane<In extends AnyEdgeDef, O extends OutputSpec>(
  nodeDef: NodeDef<In, O>,
): (payload: unknown) => Promise<OutputResult<O>> {
  return async (payload: unknown): Promise<OutputResult<O>> => {
    const validated = assertPayload(nodeDef.input, payload);
    return nodeDef.fn(validated);
  };
}
