/**
 * The membrane (docs/design.md §5) — the boundary every node invocation
 * passes through, generated purely from a node's own NodeDef. Not a
 * primitive a `.node` author declares or configures; there is nothing to
 * pass `membrane()` beyond the NodeDef itself.
 *
 * Covers `single`, `every`, and `any` InputSpecs, including compound (nested-edge)
 * and many-of-compound fields in the payload being asserted. A rejected
 * assert or an uncaught throw from `Fn` resolves to `Failed<In>` rather
 * than rejecting the returned promise — never an exception escaping the
 * boundary (design.md §3; design-history.md, "The membrane"). Builds a
 * real `Envelope` and passes it to `Fn` as its second argument when `Fn`
 * declares one (arity-detected, `fn.length >= 2` — same opt-in shape `env`
 * already has on `Fn`, made real here for the first time). Two of
 * `Envelope`'s fields are honest placeholders, not resolved: `causationId`
 * is always `null` (no causation-chain tracking exists yet — nothing
 * currently tells a node which specific upstream edge instance triggered
 * it) and `step` is always `0` (the pulse/wave model design-history.md
 * already decided isn't wired into the membrane yet). `identity` narrows
 * the caller-supplied `Identity` claims to exactly the fields a node's
 * `scope` declares (`{}` when no `scope` is declared) — only
 * `read:Identity:<field>` resolves to anything today; anything else in a
 * `scope` declaration resolves to `Failed<In>`, same as a bad assert,
 * never an uncaught exception. A caller who supplies no identity at all
 * gets a documented system default (`sub: "system"`), not an absent one —
 * design-history.md's "there is no identity-less execution" taken
 * literally. No PDP, no grant checking against a `scopes` claim — that
 * stays explicitly deferred (getting-started.md); this only narrows data,
 * it doesn't authorize anything.
 *
 * Not yet built: everything downstream of a real `correlationId` source
 * (`.topology`/the runtime decide what a node's `correlationId` actually
 * is; the membrane only ever receives one, never mints it), and a real
 * `scopes`/granted-permissions claim on `Identity` (weir's field model has
 * no scalar-array field type yet). `first`/`each` (docs/design-history.md,
 * "membrane()") are deferred further still — they distinguish reacting to
 * the 1st vs. every occurrence of a recurring edge, which can't happen
 * without a graph cycle (no edge type recurs within one invocation
 * otherwise), and cycle/bounded-iteration support doesn't exist yet either.
 */

import { hashNode } from "./hash.js";
import { Identity } from "./types.js";
import type {
  AnyEdgeDef,
  Envelope,
  Failed,
  FieldDef,
  InputPayload,
  InputSpec,
  NodeDecl,
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
 * Checks a scalar value against its field's declared `enumValues` and
 * `validations` (`min`/`max` for numbers, `minLength`/`maxLength`/`pattern`
 * for strings) — the part of the declared schema `assertPayload` used to
 * check only structurally (via `hash.ts`'s fingerprint) and never actually
 * enforced against real data (docs/open-questions.md, "`assertPayload`
 * doesn't enforce `validations`"). Only called once the value's scalar
 * type already matches, so `typeof` narrowing here is safe.
 */
function validationErrors(key: string, field: FieldDef, value: string | number | boolean): string[] {
  const errors: string[] = [];

  if (field.enumValues !== undefined && typeof value === "string" && !field.enumValues.includes(value)) {
    errors.push(`${key} must be one of ${field.enumValues.join(", ")}, got "${value}"`);
  }

  const validations = field.validations as
    | { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string }
    | undefined;
  if (validations === undefined) return errors;

  if (typeof value === "number") {
    if (validations.min !== undefined && value < validations.min) {
      errors.push(`${key} must be >= ${validations.min}, got ${value}`);
    }
    if (validations.max !== undefined && value > validations.max) {
      errors.push(`${key} must be <= ${validations.max}, got ${value}`);
    }
  }

  if (typeof value === "string") {
    if (validations.minLength !== undefined && value.length < validations.minLength) {
      errors.push(`${key} must be at least ${validations.minLength} characters, got ${value.length}`);
    }
    if (validations.maxLength !== undefined && value.length > validations.maxLength) {
      errors.push(`${key} must be at most ${validations.maxLength} characters, got ${value.length}`);
    }
    if (validations.pattern !== undefined && !new RegExp(validations.pattern).test(value)) {
      errors.push(`${key} must match pattern ${validations.pattern}, got "${value}"`);
    }
  }

  return errors;
}

/**
 * Asserts an unknown value against an edge's declared fields — scalar
 * (type, nullability, and now `enumValues`/`validations` too — see
 * `validationErrors`), compound (a nested edge, asserted recursively
 * against its own fields), or many-of-compound (a collection, keyed by
 * the referenced edge's own declared `index` field — never a bare array;
 * docs/design-history.md, "`many` is a collection, keyed by index, not an
 * array") — collecting every violation rather than stopping at the first,
 * so a caller sees the whole shape of what's wrong at once. Same
 * recursive discriminant ("many" in value / "fields" in value / else
 * scalar) as hash.ts's `fingerprint()`, one layer down from schema to
 * data. Throws immediately, not collected as a data error, if the
 * referenced edge declares no `index` at all — that's a declaration bug,
 * not bad input data.
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
      const collectionEdge = fieldDef.many;
      if (collectionEdge.index === undefined) {
        throw new Error(
          `${edge.name}.${key}: many requires "${collectionEdge.name}" to declare an index — a collection needs a real key.`,
        );
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(
          `${key} should be a collection (an object keyed by "${collectionEdge.index}"), got ${describeType(value)}`,
        );
        continue;
      }
      for (const [entryKey, entryValue] of Object.entries(value)) {
        try {
          const validated = assertPayload(collectionEdge, entryValue) as Record<string, unknown>;
          const actualKey = validated[collectionEdge.index];
          // Object keys are always strings, even when the index field's own type isn't
          // (a uint8 index like 8 stores under the key "8") — compare by string form.
          if (String(actualKey) !== entryKey) {
            errors.push(
              `${key}["${entryKey}"]: keyed by "${entryKey}" but its own "${collectionEdge.index}" is "${String(actualKey)}"`,
            );
          }
        } catch (cause) {
          errors.push(`${key}["${entryKey}"]: ${(cause as Error).message}`);
        }
      }
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
    } else {
      errors.push(...validationErrors(key, field, value as string | number | boolean));
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

/**
 * What `membrane()` returns for a `single`-input node: hand it a payload,
 * the invocation's correlationId, and (optionally) the caller's identity —
 * defaults to a documented system identity when omitted (file header).
 */
type SingleInvoke<In extends InputSpec, O extends OutputSpec> = (
  payload: unknown,
  correlationId: string,
  identity?: PayloadOf<typeof Identity>,
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
  identity?: PayloadOf<typeof Identity>,
) => Promise<OutputResult<O> | Failed<In> | undefined>;

/**
 * What `membrane()` returns for an `any`-input node: same call shape as
 * `EveryInvoke` (a readiness check against a correlation_id's logs), but
 * resolves as soon as the *first* declared edge has appeared rather than
 * requiring all of them.
 */
type AnyInvoke<In extends InputSpec, O extends OutputSpec> = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<OutputResult<O> | Failed<In> | undefined>;

type MembraneInvoke<In extends InputSpec, O extends OutputSpec> = In extends { kind: "single" }
  ? SingleInvoke<In, O>
  : In extends { kind: "every" }
    ? EveryInvoke<In, O>
    : AnyInvoke<In, O>;

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A documented default for callers who supply no identity — never an absent one (file header). */
const SYSTEM_IDENTITY: PayloadOf<typeof Identity> = { sub: "system", iss: "weir" };

const IDENTITY_FIELDS = Object.keys(Identity.fields) as (keyof PayloadOf<typeof Identity>)[];

/**
 * Narrows a full `Identity` down to exactly the fields a node's `scope`
 * declares — `{}` when no `scope` is declared (file header). Only
 * `read:Identity:<field>` resolves to anything today; any other verb or
 * edge throws, caught by the caller and turned into `Failed<In>`, never an
 * uncaught exception.
 */
function narrowIdentity(
  scope: string[] | undefined,
  identity: PayloadOf<typeof Identity>,
): Partial<PayloadOf<typeof Identity>> {
  if (!scope || scope.length === 0) return {};

  const narrowed: Partial<PayloadOf<typeof Identity>> = {};
  for (const declaration of scope) {
    const [verb, edgeName, field] = declaration.split(":");
    if (verb !== "read" || edgeName !== "Identity") {
      throw new Error(`scope "${declaration}": only "read:Identity:<field>" resolves to anything today.`);
    }
    if (!IDENTITY_FIELDS.includes(field as keyof PayloadOf<typeof Identity>)) {
      throw new Error(`scope "${declaration}": Identity has no field "${field}".`);
    }
    narrowed[field as keyof PayloadOf<typeof Identity>] = identity[field as keyof PayloadOf<typeof Identity>];
  }
  return narrowed;
}

/**
 * Builds this invocation's Envelope. `causationId` and `step` are honest
 * placeholders (see file header) — real values need mechanisms that don't
 * exist yet (causation-chain tracking, pulse scheduling), not a design
 * decision being punted silently. Can throw (a bad `scope` declaration) —
 * the caller is responsible for turning that into `Failed<In>`.
 */
async function buildEnvelope(
  nodeDef: NodeDecl,
  correlationId: string,
  identity: PayloadOf<typeof Identity>,
): Promise<Envelope> {
  return {
    id: crypto.randomUUID(),
    correlationId,
    causationId: null,
    timestamp: new Date().toISOString(),
    step: 0,
    identity: narrowIdentity(nodeDef.scope, identity),
    schemaHash: (await hashNode(nodeDef)).hash,
  };
}

/**
 * Calls `Fn` with an `Envelope` only if it declared a second parameter to
 * receive one — arity-detected (`fn.length`), the same opt-in `env` already
 * had at the type level, made real here for the first time.
 */
function callFn<In extends InputSpec, O extends OutputSpec>(
  nodeDef: NodeDef<In, O>,
  payload: InputPayload<In>,
  envelope: Envelope,
): OutputResult<O> | Failed<In> | Promise<OutputResult<O> | Failed<In>> {
  return nodeDef.fn.length >= 2 ? nodeDef.fn(payload, envelope) : nodeDef.fn(payload);
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
    const invoke: SingleInvoke<In, O> = async (payload, correlationId, identity) => {
      let validated: InputPayload<In>;
      try {
        validated = assertPayload(edge, payload) as InputPayload<In>;
      } catch (cause) {
        return { input: payload as InputPayload<In>, reason: reasonOf(cause) };
      }
      let envelope: Envelope;
      try {
        envelope = await buildEnvelope(nodeDef, correlationId, identity ?? SYSTEM_IDENTITY);
      } catch (cause) {
        return { input: validated, reason: reasonOf(cause) };
      }
      try {
        return await callFn(nodeDef, validated, envelope);
      } catch (cause) {
        return { input: validated, reason: reasonOf(cause) };
      }
    };
    return invoke as MembraneInvoke<In, O>;
  }

  if (nodeDef.input.kind === "every") {
    const edges = nodeDef.input.edges;
    const invoke: EveryInvoke<In, O> = async (correlationId, log, identity) => {
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

      let envelope: Envelope;
      try {
        envelope = await buildEnvelope(nodeDef, correlationId, identity ?? SYSTEM_IDENTITY);
      } catch (cause) {
        return { input: bag as InputPayload<In>, reason: reasonOf(cause) };
      }
      try {
        return await callFn(nodeDef, bag as InputPayload<In>, envelope);
      } catch (cause) {
        return { input: bag as InputPayload<In>, reason: reasonOf(cause) };
      }
    };
    return invoke as MembraneInvoke<In, O>;
  }

  if (nodeDef.input.kind === "any") {
    const edges = nodeDef.input.edges;
    const invoke: AnyInvoke<In, O> = async (correlationId, log, identity) => {
      let match: { edge: AnyEdgeDef; raw: unknown } | undefined;
      for (const edge of edges) {
        const value = log.latest(edge.name, correlationId);
        if (value !== undefined) {
          match = { edge, raw: value };
          break;
        }
      }
      if (!match) return undefined;

      let tagged: { edge: string; payload: unknown };
      try {
        tagged = { edge: match.edge.name, payload: assertPayload(match.edge, match.raw) };
      } catch (cause) {
        return { input: { edge: match.edge.name, payload: match.raw } as InputPayload<In>, reason: reasonOf(cause) };
      }

      let envelope: Envelope;
      try {
        envelope = await buildEnvelope(nodeDef, correlationId, identity ?? SYSTEM_IDENTITY);
      } catch (cause) {
        return { input: tagged as InputPayload<In>, reason: reasonOf(cause) };
      }
      try {
        return await callFn(nodeDef, tagged as InputPayload<In>, envelope);
      } catch (cause) {
        return { input: tagged as InputPayload<In>, reason: reasonOf(cause) };
      }
    };
    return invoke as MembraneInvoke<In, O>;
  }

  // Exhaustiveness guard: InputSpec is a closed union of single/every/any, so
  // nodeDef.input is `never` here — a future sibling kind (design-history.md's
  // still-deferred `first`/`each`) would fail loudly instead of silently
  // falling through to this branch's behavior.
  const unreachable: never = nodeDef.input;
  throw new Error(`Unrecognized InputSpec kind: ${JSON.stringify(unreachable)}`);
}
