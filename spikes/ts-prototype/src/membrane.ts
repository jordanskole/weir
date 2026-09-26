/**
 * The membrane (docs/design.md §5) — the boundary every node invocation
 * passes through, generated purely from a node's own NodeDef. Not a
 * primitive a `.node` author declares or configures; there is nothing to
 * pass `membrane()` beyond the NodeDef and the invocation's own arguments —
 * never separate configuration such as a sink or a logger.
 *
 * Covers `single` and `allOf` InputSpecs, including compound (nested-edge)
 * and many-of-compound fields in the payload being asserted. A rejected
 * assert or an uncaught throw from `Fn` resolves to `Failed<In>` rather
 * than rejecting the returned promise — never an exception escaping the
 * boundary (design.md §3; design-history.md, "The membrane"). Builds a
 * real `Envelope` and passes it to `Fn` as its second argument when `Fn`
 * declares one (arity-detected, `fn.length >= 2` — same opt-in shape `env`
 * already has on `Fn`, made real here for the first time). `causationIds`
 * is never resolved here — for a `single`- or an `allOf`-input node alike,
 * it is whatever the caller supplied in `context` (see `MembraneArgs`),
 * defaulting to `[]`. The membrane has no upstream edges of its own to
 * derive one from; for `allOf` that used to mean deriving it from the Log
 * it resolved the bag against, but the membrane no longer resolves that
 * bag (see `MembraneArgs`), so there is nothing left to derive it from
 * there either. `step` used to be a placeholder too; it is now the scheduler's
 * pulse number, passed in by whoever invokes (see `MembraneArgs`) and
 * defaulting to 0 for callers with no scheduler behind them. `identity` narrows
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
  LiteralFieldDef,
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
 * against its own fields), many-of-compound (a collection, keyed by
 * the referenced edge's own declared `index` field — never a bare array;
 * docs/design-history.md, "`many` is a collection, keyed by index, not an
 * array"), or literal (pinned to one exact constant, `LiteralFieldDef` —
 * a payload value either matches it or doesn't, nothing else to check) —
 * collecting every violation rather than stopping at the first, so a
 * caller sees the whole shape of what's wrong at once. Same recursive
 * discriminant ("many" in value / "fields" in value / "literal" in value
 * / else scalar) as hash.ts's `fingerprint()`, one layer down from schema
 * to data. Throws immediately, not collected as a data error, if the
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

    if ("literal" in fieldDef) {
      const literalField = fieldDef as LiteralFieldDef;
      if (value !== literalField.literal) {
        errors.push(`${key} is pinned to ${literalField.literal}, got ${describeType(value)}`);
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
 * An `Envelope` plus the hash of the specific edge this instance was
 * written under (docs/design.md §5) — the thing that later lets replay
 * migrate-or-refuse when stored data predates an edge change. Deliberately
 * distinct from `Envelope.contractHash` (the *node contract's* hash, fixed
 * for the whole invocation): an `allOf`-output node emits several
 * instances from one invocation, each under a different edge, so
 * `schemaHash` varies per instance while `envelope.id` (naming that one
 * invocation) stays the same across all of them.
 */
export interface InstanceEnvelope extends Envelope {
  schemaHash: string;
}

/**
 * One stored edge instance. `envelope` is absent for a *staged* input —
 * see `Log.append` — never for a real emitted instance a node produced.
 */
export interface LoggedInstance {
  /**
   * Stable identity for this instance, minted at append. This is what
   * causation will point at (docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md,
   * piece 2), which is why it is a minted string rather than `seq`: a
   * per-Log counter restarts and collides across runs, and the Trace
   * outlives one Log.
   */
  id: string;
  /**
   * Write order within one Log — a logical clock, not a causal
   * coordinate. `envelope.step` measures causal position and is shared by
   * everything in a pulse; `seq` is unique per instance, and many `seq`
   * values occur inside one pulse (design-history.md, "Three axes and a
   * clock").
   */
  seq: number;
  payload: unknown;
  envelope?: InstanceEnvelope;
}

/**
 * The per-edge-type logs a multi-input node's readiness is resolved
 * against (docs/design.md §5) — one log per edge type, each keyed by
 * correlation_id, never one shared mutable pool. `latest` returns `undefined`
 * when no instance of that edge type has appeared yet for that thread.
 */
export interface Log {
  /**
   * Stores one edge instance. The Log stores provenance but never computes
   * it: `append` receives an edge *name*, not its definition, and is
   * synchronous, while hashing an edge (`hashEdge`) needs the definition
   * and is async — so the Log cannot hash an edge even in principle. The
   * caller that knows the edge (runtime.ts's `logOutput`) hashes it and
   * passes the resulting `InstanceEnvelope`; `envelope` is omitted for a
   * staged payload with no real invocation behind it (tests, readiness
   * fixtures for an `allOf`-input node).
   *
   * Returns the new instance's `id`. The runtime tracks consumption
   * against instances it *reads*, so it does not need this today; piece 2
   * does, and retrofitting a return type across every call site later is
   * churn.
   */
  append(edgeName: string, correlationId: string, payload: unknown, envelope?: InstanceEnvelope): string;
  /**
   * `runtime.ts`'s `tryFire` is this method's one caller for an `allOf`
   * node — it reads each declared edge's latest payload to build the bag it
   * both records on the trace entry and hands to `membrane()`. Before Task
   * 4 (docs/superpowers/specs/2026-09-25-allof-joins-by-lineage.md), the
   * membrane's own `allOf` invoke read the Log a second time to resolve
   * that same bag itself, which made this method's synchronicity
   * load-bearing: nothing could append to the Log in the gap between the
   * two reads, or the trace could record an input that was never the one
   * actually invoked. The membrane no longer resolves `allOf` inputs — it
   * takes the bag as an argument instead — so `tryFire` is the sole reader
   * now, and there is no second read left to stay adjacent to.
   */
  latest(edgeName: string, correlationId: string): unknown | undefined;
  /** The full stored instance — payload plus provenance, when there is any (see `append`). */
  latestInstance(edgeName: string, correlationId: string): LoggedInstance | undefined;
  /**
   * Every retained instance of this edge type for this correlation,
   * oldest first. Returns a copy: callers iterate it while firing nodes
   * that append to the same log.
   */
  instances(edgeName: string, correlationId: string): LoggedInstance[];
  /**
   * The instance with this id, from any edge type or correlation — ids are
   * minted per append and globally unique, so no correlation is needed to
   * disambiguate. Exists so recorded `causationIds` can be resolved back
   * to instances; provenance nobody can read is provenance not worth
   * storing (the same objection that added `latestInstance`).
   */
  instanceById(id: string): LoggedInstance | undefined;
}

/** An in-memory Log — the spike has no real store yet; this is enough to test readiness against. */
export class InMemoryLog implements Log {
  private readonly entries = new Map<string, LoggedInstance[]>();
  private readonly byId = new Map<string, LoggedInstance>();
  private nextSeq = 0;
  private key(edgeName: string, correlationId: string): string {
    return `${edgeName} ${correlationId}`;
  }
  append(
    edgeName: string,
    correlationId: string,
    payload: unknown,
    envelope?: InstanceEnvelope,
  ): string {
    const key = this.key(edgeName, correlationId);
    const instance: LoggedInstance = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      payload,
      envelope,
    };
    const existing = this.entries.get(key);
    if (existing) existing.push(instance);
    else this.entries.set(key, [instance]);
    this.byId.set(instance.id, instance);
    return instance.id;
  }
  latest(edgeName: string, correlationId: string): unknown | undefined {
    return this.latestInstance(edgeName, correlationId)?.payload;
  }
  latestInstance(edgeName: string, correlationId: string): LoggedInstance | undefined {
    const list = this.entries.get(this.key(edgeName, correlationId));
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }
  instances(edgeName: string, correlationId: string): LoggedInstance[] {
    return [...(this.entries.get(this.key(edgeName, correlationId)) ?? [])];
  }
  instanceById(id: string): LoggedInstance | undefined {
    return this.byId.get(id);
  }
}

/**
 * What one pass through the membrane produced: the node's result, and the
 * envelope built for it. `envelope` is built *before* the input is
 * asserted, so it is present for every **attempt**, not only every
 * completed invocation (2026-09-24, superseding the narrower "present iff
 * `Fn` actually ran" rule this file used to document — see
 * docs/superpowers/specs/2026-09-23-invocation-records-and-replay.md §4 for
 * the superseded reasoning and what changed). A rejected input assert now
 * carries a real envelope, since `Fn`'s not having run is exactly the thing
 * worth recording provenance for.
 *
 * `envelope` stays **optional**, though, and the remaining case where it is
 * absent is much narrower than before: only when `buildEnvelope` itself
 * throws (a bad `scope` declaration — see its own doc comment). There,
 * nothing was ever built to attach; the declaration is broken regardless of
 * what input arrives, so this isn't an "attempt" in the sense the rest of
 * this comment describes. Before 2026-09-24, `envelope` was absent for
 * *any* rejected input — every `Failed<In>` from a bad payload, not just
 * the rare bad-declaration case. Narrowing that to one path is the real
 * improvement here; it is not "nothing changed." `tryFire` (`runtime.ts`)
 * and `instanceEnvelope` (`runtime.ts`) both still check for this case —
 * their checks are not dead code merely because it's rare, and deleting
 * them would let a bad-scope node's firing corrupt a trace entry or a
 * logged instance with a spread of `undefined` instead of failing cleanly.
 *
 * The envelope is returned rather than a recording sink being passed in,
 * because `membrane()` takes nothing but the declaration and the
 * invocation's own arguments (see this file's header) — what it hands back
 * may grow; what configures it may not.
 */
export interface Invocation<In extends InputSpec, O extends OutputSpec> {
  result: OutputResult<O> | Failed<In>;
  envelope?: Envelope;
}

/**
 * The envelope fields an invocation's *caller* supplies, as against the
 * ones the membrane derives for itself (`id`, `timestamp`, `node`,
 * `contractHash`). Grouped rather than passed positionally because the
 * list grows: `identity`, then `step`, then `causationIds`, and four
 * optional positional parameters is where a signature stops being
 * readable — the same slide that took `runNetlist` to seven before `Run`
 * and `Host` split it.
 *
 * `identity` is typed `Partial`, not the full `PayloadOf<typeof Identity>`:
 * a live caller normally supplies the full claims set, but `replay.ts`
 * supplies a previously *narrowed* identity. Re-feeding a narrowed
 * identity through the same narrowing is idempotent under an unchanged
 * `scope`, which is what makes replay work.
 *
 * `step` is the scheduler's pulse number, threaded in rather than stamped
 * on afterwards: the envelope is built before `Fn` runs and handed to it,
 * so a caller patching the returned envelope would leave `Fn` seeing a
 * value the log disagrees with. A caller with no scheduler behind it gets
 * the documented default of 0.
 */
export interface InvocationContext {
  correlationId: string;
  identity?: Partial<PayloadOf<typeof Identity>>;
  step?: number;
  /** See `Envelope.causationIds`. Defaults to `[]` — a caller with no notion of a consumed instance records nothing. */
  causationIds?: string[];
  /**
   * The node's *position* in the wiring, when that differs from its
   * declared name. An inlined composite's inner nodes are keyed by position
   * (`investigate/investigateIdentity`) while keeping their original `name`,
   * because `name` is in the contract hash and is the implementation
   * resolution path. Provenance wants the position: it is what distinguishes
   * two instances of the same composite, and it is what the arc rule matches
   * a producer against. Defaults to `nodeDef.name`, correct for every node
   * that is not an inlined copy.
   */
  nodeName?: string;
}

/**
 * `membrane()`'s arguments after the declaration itself. A `single`-input
 * node takes a payload directly and the invocation's `InvocationContext`.
 * An `allOf`-input node takes a bag (keyed by edge name) instead of a
 * payload, plus the same context — the same shape as `single`'s payload
 * argument, one level up. The membrane does not resolve this bag itself
 * (docs/superpowers/specs/2026-09-25-allof-joins-by-lineage.md §5): the
 * caller — the runtime, choosing a specific combination by lineage —
 * resolves it and hands it in already assembled, exactly as a `single`
 * caller hands in an already-resolved payload.
 */
type MembraneArgs<In extends InputSpec> = In extends { kind: "single" }
  ? [payload: unknown, context: InvocationContext]
  : [bag: Record<string, unknown>, context: InvocationContext];

/**
 * What `membrane()` resolves to: always a real `Invocation`, for either
 * InputSpec kind. An `allOf`-input node used to resolve to `undefined` as a
 * bare readiness signal when the edges it declared needing hadn't all
 * appeared yet in the Log it read; now that the membrane takes an
 * already-resolved bag instead of resolving one itself, there is no
 * readiness left for it to check — an incomplete bag fails `assertPayload`
 * like any other bad input and resolves to `Failed<In>`, the same as a
 * `single`-input node's bad payload.
 */
type MembraneResult<In extends InputSpec, O extends OutputSpec> = Invocation<In, O>;

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A documented default for callers who supply no identity — never an absent one (file header). */
const SYSTEM_IDENTITY: PayloadOf<typeof Identity> = { sub: "system", iss: "weir" };

const IDENTITY_FIELDS = Object.keys(Identity.fields) as (keyof PayloadOf<typeof Identity>)[];

/**
 * Narrows an `Identity` down to exactly the fields a node's `scope`
 * declares — `{}` when no `scope` is declared (file header). Only
 * `read:Identity:<field>` resolves to anything today; any other verb or
 * edge throws, caught by the caller and turned into `Failed<In>`, never an
 * uncaught exception. `identity` itself is `Partial`, not the full claims
 * shape: an already-narrowed identity (replay's case — see `MembraneArgs`'s
 * doc comment) can be fed back in here, and narrowing it again by the same
 * `scope` is a no-op, since only fields present are ever read.
 */
function narrowIdentity(
  scope: string[] | undefined,
  identity: Partial<PayloadOf<typeof Identity>>,
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
 * Builds this invocation's Envelope. `causationIds` defaults to `[]` when
 * the caller supplies none in `context` — true for an origin invocation,
 * and for any caller with no notion of a consumed instance (`invoke.ts`'s
 * single invocation, tests) — and, since Task 4, equally true for the
 * `allOf` branch below: it no longer derives `causationIds` itself, so it
 * takes whatever `context` supplies the same way the `single` branch above
 * does. `step` is the pulse number under the runtime's pulse scheduling,
 * which is exactly causal position within the topology. Defaults to 0 for
 * callers with no scheduler behind them.
 *
 * Can throw (a bad `scope` declaration) — the caller is responsible for
 * turning that into `Failed<In>`.
 */
async function buildEnvelope(nodeDef: NodeDecl, context: InvocationContext): Promise<Envelope> {
  return {
    id: crypto.randomUUID(),
    correlationId: context.correlationId,
    causationIds: context.causationIds ?? [],
    timestamp: new Date().toISOString(),
    step: context.step ?? 0,
    identity: narrowIdentity(nodeDef.scope, context.identity ?? SYSTEM_IDENTITY),
    node: context.nodeName ?? nodeDef.name,
    contractHash: (await hashNode(nodeDef)).hash,
  };
}

/**
 * Calls `Fn` with an `Envelope` only if it declared a second parameter to
 * receive one — arity-detected (`fn.length`), the same opt-in `env` already
 * had at the type level, made real here for the first time.
 *
 * Arity and `scope` are deliberately orthogonal, and it's worth saying so
 * because they look like they should be the same switch. `scope` decides
 * what's *inside* `envelope.identity` (see `narrowIdentity`); arity decides
 * whether the implementation wanted the envelope at all. Identity is one of
 * eight fields on it — a node may well want `correlationId` or `step` while
 * declaring no scope whatsoever, and that node receives an envelope whose
 * `identity` narrowed to nothing. An earlier project of Jordan's (described
 * in design-history.md) settled this the same way: its handler signature
 * always carried the scoped-environment parameter, with the declared list
 * narrowing the parameter's *type* rather than gating its presence, so
 * declaring nothing yielded an empty object that was still passed.
 */
function callFn<In extends InputSpec, O extends OutputSpec>(
  nodeDef: NodeDef<In, O>,
  payload: InputPayload<In>,
  envelope: Envelope,
): OutputResult<O> | Failed<In> | Promise<OutputResult<O> | Failed<In>> {
  return nodeDef.fn.length >= 2 ? nodeDef.fn(payload, envelope) : nodeDef.fn(payload);
}

/**
 * Wraps a node's Fn so it can never run against an unasserted input.
 * `membrane()` takes the declaration and the invocation's own arguments —
 * never separate configuration such as a sink or a logger — and performs
 * the invocation itself rather than handing back a callable for the caller
 * to invoke later: no detached invoker is ever held outside this function.
 * That means "if you call membrane, these things happen" is guaranteed by
 * this function's shape. It does not mean "invocation only ever happens
 * through membrane" — `nodeDef.fn` is still a public field, reachable
 * directly, so that stronger claim remains a matter of convention, not
 * something this refactor makes structural. Its call shape (a payload
 * directly, or a bag keyed by edge name) is entirely a product of what the
 * NodeDef's `input` says, never separately configured; both are already
 * resolved by the caller, never re-resolved here. A rejected assert or an
 * uncaught throw from `Fn` resolves to `Failed<In>` — `{ input, reason }` —
 * rather than rejecting; nothing escapes the boundary as an exception
 * (design.md §3).
 */
export async function membrane<In extends InputSpec, O extends OutputSpec>(
  nodeDef: NodeDef<In, O>,
  ...args: MembraneArgs<In>
): Promise<MembraneResult<In, O>> {
  if (nodeDef.input.kind === "single") {
    const edge = nodeDef.input.edge;
    const [payload, context] = args as unknown as [payload: unknown, context: InvocationContext];
    let envelope: Envelope;
    try {
      envelope = await buildEnvelope(nodeDef, context);
    } catch (cause) {
      return { result: { input: payload as InputPayload<In>, reason: reasonOf(cause) } } as MembraneResult<In, O>;
    }
    let validated: InputPayload<In>;
    try {
      validated = assertPayload(edge, payload) as InputPayload<In>;
    } catch (cause) {
      return {
        result: { input: payload as InputPayload<In>, reason: reasonOf(cause) },
        envelope,
      } as MembraneResult<In, O>;
    }
    try {
      return { result: await callFn(nodeDef, validated, envelope), envelope } as MembraneResult<In, O>;
    } catch (cause) {
      return { result: { input: validated, reason: reasonOf(cause) }, envelope } as MembraneResult<In, O>;
    }
  }

  if (nodeDef.input.kind === "allOf") {
    const edges = nodeDef.input.edges;
    const [rawBag, context] = args as unknown as [rawBag: Record<string, unknown>, context: InvocationContext];

    // The membrane no longer resolves this node's inputs. The runtime
    // chose a specific combination by lineage (docs/superpowers/specs/
    // 2026-09-25-allof-joins-by-lineage.md §5) and re-resolving here would
    // discard that group and read the latest instead. It also retires the
    // read-adjacency hazard this loop used to be one half of: one reader,
    // so no window to be adjacent across. Causation is supplied by
    // whoever resolved the input, which is now the runtime.
    let envelope: Envelope;
    try {
      envelope = await buildEnvelope(nodeDef, context);
    } catch (cause) {
      return { result: { input: rawBag as InputPayload<In>, reason: reasonOf(cause) } } as MembraneResult<In, O>;
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
      return {
        result: { input: rawBag as InputPayload<In>, reason: errors.join("; ") },
        envelope,
      } as MembraneResult<In, O>;
    }

    try {
      return { result: await callFn(nodeDef, bag as InputPayload<In>, envelope), envelope } as MembraneResult<In, O>;
    } catch (cause) {
      return { result: { input: bag as InputPayload<In>, reason: reasonOf(cause) }, envelope } as MembraneResult<In, O>;
    }
  }

  // Exhaustiveness guard: InputSpec is a closed union of single/allOf, so
  // nodeDef.input is `never` here — a future sibling kind would fail loudly
  // instead of silently falling through to this branch's behavior.
  const unreachable: never = nodeDef.input;
  throw new Error(`Unrecognized InputSpec kind: ${JSON.stringify(unreachable)}`);
}
