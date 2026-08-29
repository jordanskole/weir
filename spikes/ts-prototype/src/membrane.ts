/**
 * The membrane (docs/design.md §5) — the boundary every node invocation
 * passes through, generated purely from a node's own NodeDef. Not a
 * primitive a `.node` author declares or configures; there is nothing to
 * pass `membrane()` beyond the NodeDef itself.
 *
 * Covers `single` and `every` InputSpecs, including compound (nested-edge)
 * and many-of-compound fields in the payload being asserted. A rejected
 * assert or an uncaught throw from `Fn` resolves to `Failed<In>` rather
 * than rejecting the returned promise — never an exception escaping the
 * boundary (design.md §3; design-history.md, "The membrane"). Not yet
 * built: `scope`/identity resolution. `first`/`each` (docs/design-history.md,
 * "membrane()") are deferred further still — they distinguish reacting to
 * the 1st vs. every occurrence of a recurring edge, which can't happen
 * without a graph cycle (no edge type recurs within one invocation
 * otherwise), and cycle/bounded-iteration support doesn't exist yet either.
 */

import type {
  AnyEdgeDef,
  Failed,
  FieldDef,
  InputPayload,
  InputSpec,
  NodeDef,
  OutputResult,
  OutputSpec,
  PayloadOf,
} from "./types.js";

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
 * Asserts an unknown value against an edge's declared fields — scalar,
 * compound (a nested edge, asserted recursively against its own fields),
 * or many-of-compound (an array, each item asserted against the inner
 * edge) — collecting every violation rather than stopping at the first, so
 * a caller sees the whole shape of what's wrong at once. Same recursive
 * discriminant ("many" in value / "fields" in value / else scalar) as
 * hash.ts's `fingerprint()`, one layer down from schema to data.
 */
export function assertPayload<E extends AnyEdgeDef>(edge: E, payload: unknown): PayloadOf<E> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${edge.name}: expected an object, got ${describeType(payload)}.`);
  }

  const record = payload as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, fieldDef] of Object.entries(edge.fields)) {
    const value = record[key];

    if ("many" in fieldDef) {
      if (!Array.isArray(value)) {
        errors.push(`${key} should be an array, got ${describeType(value)}`);
        continue;
      }
      value.forEach((item, i) => {
        try {
          assertPayload(fieldDef.many, item);
        } catch (cause) {
          errors.push(`${key}[${i}]: ${(cause as Error).message}`);
        }
      });
      continue;
    }

    if ("fields" in fieldDef) {
      try {
        assertPayload(fieldDef, value);
      } catch (cause) {
        errors.push(`${key}: ${(cause as Error).message}`);
      }
      continue;
    }

    const field = fieldDef as FieldDef;

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
 * The per-edge-type logs a multi-input node's readiness is resolved
 * against (docs/design.md §5) — one log per edge type, each keyed by
 * correlation_id, never one shared mutable pool. `latest` returns `undefined`
 * when no instance of that edge type has appeared yet for that thread.
 */
export interface Log {
  append(edgeName: string, correlationId: string, payload: unknown): void;
  latest(edgeName: string, correlationId: string): unknown | undefined;
}

/** An in-memory Log — the spike has no real store yet; this is enough to test readiness against. */
export class InMemoryLog implements Log {
  private readonly entries = new Map<string, unknown>();
  private key(edgeName: string, correlationId: string): string {
    return `${edgeName} ${correlationId}`;
  }
  append(edgeName: string, correlationId: string, payload: unknown): void {
    this.entries.set(this.key(edgeName, correlationId), payload);
  }
  latest(edgeName: string, correlationId: string): unknown | undefined {
    return this.entries.get(this.key(edgeName, correlationId));
  }
}

/** What `membrane()` returns for a `single`-input node: hand it a payload directly. */
type SingleInvoke<In extends InputSpec, O extends OutputSpec> = (
  payload: unknown,
) => Promise<OutputResult<O> | Failed<In>>;

/**
 * What `membrane()` returns for an `every`-input node: a readiness check
 * against a correlation_id's logs, not a direct payload. Resolves to
 * `undefined` — not an error — when the edges it declared needing haven't
 * all appeared yet; a caller (a scheduler, not built here) decides when to
 * try again.
 */
type EveryInvoke<In extends InputSpec, O extends OutputSpec> = (
  correlationId: string,
  log: Log,
) => Promise<OutputResult<O> | Failed<In> | undefined>;

type MembraneInvoke<In extends InputSpec, O extends OutputSpec> = In extends { kind: "single" }
  ? SingleInvoke<In, O>
  : EveryInvoke<In, O>;

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Wraps a node's Fn so it can never run against an unasserted or
 * not-yet-ready input. `membrane(nodeDef)` takes nothing but the
 * declaration itself — the returned function's behavior, and its very
 * shape (direct payload vs. correlation-id readiness check), is entirely a
 * product of what the NodeDef's `input` says, never separately configured.
 * A rejected assert or an uncaught throw from `Fn` resolves to `Failed<In>`
 * — `{ input, reason }` — rather than rejecting; nothing escapes the
 * boundary as an exception (design.md §3).
 */
export function membrane<In extends InputSpec, O extends OutputSpec>(
  nodeDef: NodeDef<In, O>,
): MembraneInvoke<In, O> {
  if (nodeDef.input.kind === "single") {
    const edge = nodeDef.input.edge;
    const invoke: SingleInvoke<In, O> = async (payload) => {
      let validated: InputPayload<In>;
      try {
        validated = assertPayload(edge, payload) as InputPayload<In>;
      } catch (cause) {
        return { input: payload as InputPayload<In>, reason: reasonOf(cause) };
      }
      try {
        return await nodeDef.fn(validated);
      } catch (cause) {
        return { input: validated, reason: reasonOf(cause) };
      }
    };
    return invoke as MembraneInvoke<In, O>;
  }

  const edges = nodeDef.input.edges;
  const invoke: EveryInvoke<In, O> = async (correlationId, log) => {
    const rawBag: Record<string, unknown> = {};
    for (const edge of edges) {
      const value = log.latest(edge.name, correlationId);
      if (value === undefined) return undefined;
      rawBag[edge.name] = value;
    }

    const bag: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const edge of edges) {
      try {
        bag[edge.name] = assertPayload(edge, rawBag[edge.name]);
      } catch (cause) {
        errors.push(reasonOf(cause));
      }
    }
    if (errors.length > 0) {
      return { input: rawBag as InputPayload<In>, reason: errors.join("; ") };
    }

    try {
      return await nodeDef.fn(bag as InputPayload<In>);
    } catch (cause) {
      return { input: bag as InputPayload<In>, reason: reasonOf(cause) };
    }
  };
  return invoke as MembraneInvoke<In, O>;
}
