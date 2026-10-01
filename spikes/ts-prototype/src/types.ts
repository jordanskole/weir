/**
 * Core types for edge definitions.
 *
 * An edge is a named schema — the shape of what crosses a wire between nodes.
 * Compatibility between edges is structural (see docs/design.md §2); a name
 * exists so that refinement (two edges with identical shape but distinct
 * meaning, e.g. PersonReceived vs. PersonValidated) can be expressed when a
 * decision needs to survive into the next node's type.
 */

/** Scalar field types. `datetime` is an ISO-8601 string, not a numeric epoch — see
 * docs/design-history.md, "A real datetime scalar type" for why. */
export const SCALAR_TYPES = [
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
] as const;

/**
 * Derived from `SCALAR_TYPES` rather than written twice. A hand-maintained
 * union beside a hand-maintained array drifts; this cannot. The runtime list
 * is needed because a `.edge` file's `type:` arrives as `unknown` and is
 * cast — the one place a type comes from an author is the one place
 * TypeScript cannot check it, which is how `type: notatype` elaborated
 * cleanly and was counted by `weir check` as a valid edge.
 */
export type ScalarType = (typeof SCALAR_TYPES)[number];

/**
 * What each integer type's name actually promises, as bounds.
 *
 * Read by `membrane.ts` (to enforce them) and by `emit-zod.ts` (to emit them).
 * One table because two copies of it is the drift this repo keeps finding — and
 * because until 2026-10-01 there were zero copies: `typeofFor` collapsed every
 * numeric type to `"number"`, so a declared `uint8` accepted -5, 1e9 and 1.5 and
 * the width was documentation.
 */
export const INT_BOUNDS = {
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
} as const satisfies Partial<Record<ScalarType, readonly [number, number]>>;

/** Whether a scalar type is one of the sized integers in `INT_BOUNDS`. */
export function isIntegerType(type: ScalarType): type is keyof typeof INT_BOUNDS {
  return type in INT_BOUNDS;
}

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

interface FieldDefBase<T extends ScalarType> {
  type: T;
  label: string;
  description: string;
  measure?: Measure;
  format?: Format;
  unit?: string;
  enumValues?: string[];
  relation?: Relation;
  /**
   * What kind of sensitive thing this field carries — `design.md` §7's
   * field-level classification, the half that combines with zones to make
   * leakage a static query rather than a review comment.
   *
   * **Deliberately an open string, like `zone`.** §7 names PII and financial as
   * *examples*; a closed enum is easy to add later and impossible to remove once
   * somebody's ontology depends on a label this repo did not think of.
   *
   * **Fingerprinted** (hash.ts), on the precedent `relation` sets: metadata that
   * describes what the data *means* is part of the contract, even when it does
   * not change what `Fn` receives. A classification decides whether a topology
   * is legal, which is a stronger claim to contract-membership than `relation`
   * has.
   */
  classification?: string;
  /**
   * How several inputs' values for this field merge at a fan-in
   * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md §3).
   *
   * Envelope fields only, and **required** on them — there is no default,
   * because every wrong guess is silent: `meet` where `same` was meant merges
   * two tokens about different things without complaining.
   *
   * - `meet` — the weakest wins. A combined trust is no stronger than its
   *   weakest source.
   * - `join` — the strongest wins. Integrity joins where confidentiality meets,
   *   which is why one walk cannot produce both.
   * - `same` — all inputs must agree or the firing fails; the right rule for an
   *   identifier, and what catches a cross-item join.
   */
  combine?: "meet" | "join" | "same";
  /**
   * This enum's declared `enumValues` order is a total order, weakest first.
   * Required by `meet` and `join`, which otherwise have nothing to compare.
   */
  ordinal?: boolean;
  validations?: Validation<T>;
  /** Original field name in an upstream source, where this edge is derived from one. */
  sourceKey?: string;
}

/**
 * Rich metadata for a single field on an edge. `nullable` is required for
 * every type except `bool`, where it's disallowed entirely — a nullable
 * boolean is a tri-state in disguise (set-true / set-false / unset-or-null,
 * three states pretending to be two), the kind of ambiguity a real type
 * should resolve, not carry forward. `N` (default wide — `boolean`, not
 * `false` — so a bare `FieldDef` reference stays compatible with a nullable
 * field; only `defineField`'s own default narrows to non-nullable) controls
 * whether the field's payload type is `T | null`. Explicit `T | null`, not an
 * optional/absent key — the same call docs/design-history.md made for
 * `Envelope`'s old singular `causationId` field (since replaced by the
 * never-nullable `causationIds: string[]`): a nullable field forces a
 * caller to handle the null, an absent key doesn't force anything.
 */
export type FieldDef<T extends ScalarType = ScalarType, N extends boolean = boolean> = T extends "bool"
  ? FieldDefBase<T>
  : FieldDefBase<T> & { nullable: N };

/**
 * A field pinned to a single boolean constant, never caller-suppliable —
 * for spread-with-override (`edge CompletedTodo { ...Todo, is_complete: true }`,
 * docs/superpowers/specs/2026-09-09-edge-spread.md). A distinct field kind, not
 * a `bool` with a value attached: no `nullable`, no `validations`, both
 * meaningless on a fixed constant.
 */
export interface LiteralFieldDef {
  literal: boolean;
  label?: string;
  description?: string;
}

type NumberValidation = { 
  min?: number;
  max?: number;
}
  
type StringValidation = {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

type Validation<T extends ScalarType> = T extends "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "f32" | "f64"
? NumberValidation
: T extends "utf8" | "datetime"
  ? StringValidation
  : never;



/**
 * An edge definition: name, human-readable label, description, optional
 * index field, and field map. `name` is identity — derived from the
 * filename for a standalone `.edge` file, never authored free text. `label`
 * is the human-readable counterpart, same role as `FieldDef.label` — no
 * expectation it matches `name`, the way a field's `label` was never
 * expected to match its map key.
 */
export interface EdgeDef<
  F extends Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef> = Record<string, FieldDef>,
> {
  name: string;
  label: string;
  description: string;
  /** Field that uniquely identifies an instance, where one exists. */
  index?: string;
  fields: F;
  /**
   * The edge this one's fields were spread from, where `"...Name":` was used
   * (docs/superpowers/specs/2026-09-09-edge-spread.md).
   *
   * Provenance of the *declaration*, not of the data: the spread copies fields
   * in, so an edge written by spread and one written by hand are the same edge
   * on the wire. `fingerprint` names its keys explicitly and does not include
   * this, which is what keeps that true — changing a spread into four typed-out
   * fields must not move a contract hash.
   *
   * Recorded because the copy is otherwise lossy in one place that matters:
   * the spread source is a real, declared edge that nothing produces, consumes
   * or embeds, so `sys` reported it as orphaned with no way to tell it apart
   * from actual dead weight.
   */
  spreadFrom?: string;
}

/**
 * A field holding many instances of a compound edge — `design.md` §3's
 * `many` cardinality (already used by `.node`'s `output:`), applied one
 * layer down to a field's value instead of a node's result. The key
 * (`many`) is the discriminant, same "key is the discriminant" idiom
 * `.node`'s `oneOf`/`allOf`/`many` output shapes already use.
 */
export interface ManyEdgeDef<E extends AnyEdgeDef = AnyEdgeDef> {
  many: E;
}

/**
 * An EdgeDef whose fields may include compound (nested-edge) or many-of-edge
 * fields, not just scalars, at any nesting depth — self-referential on
 * purpose, so a compound field's own fields can themselves contain compound
 * or many fields. A bare `EdgeDef` (no type argument) resolves to `EdgeDef`'s
 * narrow default (`Record<string, FieldDef>`), not its wider constraint — so
 * anywhere a generic bound needs to admit a compound or many field, it must
 * say so with this alias rather than writing `EdgeDef` bare.
 */
export type AnyEdgeDef = EdgeDef<Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef>>;

/**
 * The unit edge — the only special edge (docs/design.md §5). An origin
 * node's input is Unit rather than `null`, so origins aren't a schema-level
 * special case: every node's input is a real, named edge.
 */
export const Unit: EdgeDef<Record<string, never>> = {
  name: "Unit",
  label: "Unit",
  description: "The unit edge — an origin node's input, carrying no data.",
  fields: {},
};

/** Maps a scalar edge type to the TypeScript type its instances carry. */
export type ScalarTsType<T extends ScalarType> = T extends "utf8" | "datetime"
  ? string
  : T extends "bool"
    ? boolean
    : number;

/**
 * The runtime payload shape produced by a field map. A field is a scalar
 * (FieldDef), a compound nested edge (EdgeDef, recursing into that edge's
 * own payload shape), or many instances of a compound edge (ManyEdgeDef,
 * an array of that edge's payload shape).
 */
/**
 * A `many` field or output is a collection, not an array — keyed by the
 * referenced edge's own declared `index` field, never bare position
 * (docs/design-history.md, "`many` is a collection, keyed by index, not
 * an array"). One edge instance, one collection payload; never N separate
 * instances of the referenced edge.
 */
export type Payload<F extends Record<string, FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T, infer N>
    ? N extends true
      ? ScalarTsType<T> | null
      : ScalarTsType<T>
    : F[K] extends LiteralFieldDef
      ? boolean
      : F[K] extends ManyEdgeDef<infer E>
        ? Record<string, PayloadOf<E>>
        : F[K] extends AnyEdgeDef
          ? PayloadOf<F[K]>
          : never;
};

/** The runtime payload shape of an edge definition. */
export type PayloadOf<E extends AnyEdgeDef> = Payload<E["fields"]>;

/**
 * The one true framework-provided system edge (docs/design-history.md,
 * "Membrane moves out of Primitives; identity resolves to one system
 * edge") — the "on behalf of" every invocation runs as, verified exactly
 * once by the outer membrane from a JWT and never produced by an ordinary
 * node. `sub`/`iss` are non-nullable: there is no identity-less execution,
 * not even a system/scheduler-triggered one (design-history.md, "Identity
 * is the actor, edges are the resource") — an anonymous or system actor
 * still gets real, non-null claims (e.g. `sub: "system"`), never an absent
 * or empty Identity. What richer things `sub`/`iss` alone can't carry
 * (a `scopes`/granted-permissions claim, in particular) stays punted:
 * weir's field model has no scalar-array field type yet, a real,
 * independent gap discovered building this, not the same thing as the
 * separately-deferred PDP question (getting-started.md).
 */
export const Identity: EdgeDef<{ sub: FieldDef<"utf8">; iss: FieldDef<"utf8"> }> = {
  name: "Identity",
  label: "Identity",
  description: "The verified-once JWT claims an invocation runs on behalf of.",
  fields: {
    sub: { type: "utf8", label: "Subject", description: "The identity's subject claim.", nullable: false },
    iss: { type: "utf8", label: "Issuer", description: "The identity's issuer claim.", nullable: false },
  },
};

/**
 * Per-invocation metadata wrapping every edge instance (docs/design.md §1).
 * A node's Fn does not see this by default; a second `env` parameter is
 * what opts a node into being context-dependent (routers, dedupers).
 * `identity` is narrowed to exactly the fields a node's `scope` declares
 * (docs/design-history.md, "Identity is a verified-once JWT..."), `{}`
 * when no `scope` is declared — never the whole object, hence `Partial`
 * rather than `PayloadOf<typeof Identity>`'s full shape.
 */
export interface Envelope {
  /**
   * Declared-envelope values this invocation may read, narrowed by its `scope`
   * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md).
   *
   * The *read* view, deliberately narrower than what the token carries: a token
   * keeps every envelope field through a node that can read none of them.
   */
  meta?: Record<string, unknown>;
  id: string;
  correlationId: string;
  /**
   * The instances this invocation consumed. Empty for an origin — an
   * external event caused it, and an external event is not a token — and
   * for an out-of-band invocation with no log behind it (`invoke.ts`).
   * One entry for a `single`-input node; N for an `allOf` node, one per
   * declared input edge.
   *
   * Plural rather than singular because an `allOf` invocation genuinely
   * consumes several tokens, and a singular field could only name one of
   * them — losing lineage at exactly the fan-in nodes that lineage is
   * wanted for. This is OpenTelemetry's `parentSpanId` with the one
   * difference that matters: a span has one parent, an `allOf` invocation
   * has N.
   *
   * Never nullable. "Nothing caused this" is `[]`.
   */
  causationIds: string[];
  timestamp: string;
  step: number;
  identity: Partial<PayloadOf<typeof Identity>>;
  /**
   * The node this invocation ran. Half of the version pin: with
   * `contractHash` it names exactly one accepted implementation file
   * (`{node}/{short(contractHash)}.ts`), because docs/design.md §10
   * guarantees one accepted implementation per contract state and never
   * overwrites. docs/design-history.md left "the version-pin field's exact
   * name/shape" open — it turns out to be an identity that was never
   * recorded, not a hash that needed adding.
   */
  node: string;
  /**
   * The node *contract's* hash — the value `schemaHash` held all along,
   * under a name that says what it is. Deliberately not the edge's schema
   * hash (docs/design.md §5): that is a property of an emitted instance,
   * varies per emitted edge within one invocation, and lives on
   * `InstanceEnvelope` instead (see the Log, membrane.ts).
   */
  contractHash: string;
  /**
   * Which implementation of that contract actually ran (`hashSource` of its
   * source text). Absent for an effect node, which has no accepted artifact
   * — its behaviour is a host handler, and pinning that is a separate
   * question.
   */
  implementationHash?: string;
}

/**
 * A node's input shape (docs/design.md §5) — a single edge, or several via
 * `allOf`, a readiness condition the membrane resolves against a
 * `correlation_id`'s per-edge-type logs, never a synchronous join or an
 * accumulator (docs/design-history.md, "The membrane"). Mirrors OutputSpec's
 * "kind is the discriminant" idiom on purpose — `single` here is the same
 * shape `single()` already produces for OutputSpec, so the same helper
 * serves both.
 */
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "allOf"; edges: AnyEdgeDef[] }
  /**
   * Every instance of one edge descended from a single spread, collected
   * into one payload — the dual of `spread`
   * (docs/superpowers/specs/2026-09-27-gather.md). `sequence` in the
   * functional sense: `t (f a) → f (t a)`.
   *
   * Distinct from `allOf`, which takes one of several *different* edges
   * with cardinality fixed by its declaration. A gather takes N of *one*
   * edge, and N is decided at runtime by the spread that produced them —
   * which is why readiness cannot come from the contract and comes from
   * the collection token's own size instead.
   */
  | {
      kind: "gather";
      edge: AnyEdgeDef;
      /**
       * The edge whose arrival closes the barrier, for a gather over a **cycle**
       * rather than a spread
       * (docs/superpowers/specs/2026-09-29-gather-until.md).
       *
       * A spread's barrier is a *count* — the collection token records it. A
       * cycle has neither collection nor count, and needs neither: a cycle is
       * **sequential**, so by the time its terminating branch appears, every
       * element already exists and is an ancestor of it. The barrier is "the
       * terminator exists", and membership is "every instance of `edge` among
       * the terminator's ancestors".
       *
       * Absent for an ordinary gather, which keeps the count-based barrier.
       */
      until?: AnyEdgeDef;
      /**
       * Other outcomes that also count as an element having **resolved**
       * (docs/superpowers/specs/2026-10-01-gather-settled.md).
       *
       * A gather's barrier is *"every element resolved"*, and "resolved" has
       * always meant "produced an instance of the gathered edge" — a declared
       * set of exactly one. Widening that set is the whole feature; today's
       * all-or-nothing behaviour is the degenerate case with `settled` absent,
       * not a parallel mechanism.
       *
       * **This widens the barrier, never the payload.** `Fn` still receives a
       * collection of `edge` alone — a node takes a single input, and the
       * partition lives in the topology as a second gather on the other wire.
       *
       * Named rather than implied: there is no threshold and no automatic
       * tolerance of `Failed_*`, because a gather that silently absorbed
       * failures makes "3,264 of 3,265 succeeded" indistinguishable from
       * "3,265 succeeded".
       */
      settled?: AnyEdgeDef[];
    };

/**
 * The edge names an input declares needing, whatever multiplicity it needs them
 * at. A `gather` needs N of one edge, but they arrive one instance at a time on
 * one arc, so the *arc* question this answers has the same shape as a `single`
 * input's.
 *
 * Lives here rather than in either consumer because both ask the identical
 * question of the same closed union and neither owns it: `elaborate.ts`'s wiring
 * rules ask "can anything wired into this node satisfy it", and `runtime.ts`'s
 * residue check asks "is anything still waiting at it"
 * (docs/superpowers/specs/2026-09-27-quiescence-is-not-success.md §2). Two copies
 * would be two places for a fourth input kind to be forgotten — which is exactly
 * what happened when `gather` was added and `InputSpec`'s consumers had to be
 * enumerated by the typechecker one at a time.
 */
export function inputEdgeNames(input: InputSpec): string[] {
  if (input.kind === "single" || input.kind === "gather") return [input.edge.name];
  return input.edges.map((edge) => edge.name);
}

/**
 * The payload shape Fn receives for a given InputSpec: the edge's own
 * payload for `single`; a bag keyed by edge name for `allOf`, matching the
 * `given`/`expect` name-as-key tagging convention already decided for
 * `.node` examples (docs/design-history.md).
 */
export type InputPayload<I extends InputSpec> = I extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : I extends { kind: "allOf"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
    : // A keyed collection, the same shape a `many` output produces — keyed
      // by the gathered edge's own `index`, never an array
      // (design-history.md, "`many` is a collection, keyed by index").
      I extends { kind: "gather"; edge: infer E extends AnyEdgeDef }
      ? Record<string, PayloadOf<E>>
      : never;

/**
 * A node's output shape (docs/design.md §3) — the three fan-out modes plus
 * the plain single-edge case, kept as distinct kinds so they can't be
 * conflated the way Node-RED's "multiple outputs" was (see
 * docs/design-history.md, "Fan-out is three different things").
 */
export type OutputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "oneOf"; edges: AnyEdgeDef[] }
  | { kind: "allOf"; edges: AnyEdgeDef[] }
  | { kind: "many"; edge: AnyEdgeDef };

/** One branch of a oneOf/allOf result: which edge fired, and its payload. */
type Tagged<E extends AnyEdgeDef> = { edge: E["name"]; payload: PayloadOf<E> };

/** The value a node's Fn must return, given its declared OutputSpec. */
export type OutputResult<O extends OutputSpec> = O extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : O extends { kind: "oneOf"; edges: infer Es extends AnyEdgeDef[] }
    ? { [I in keyof Es]: Es[I] extends AnyEdgeDef ? Tagged<Es[I]> : never }[number]
    : O extends { kind: "allOf"; edges: infer Es extends AnyEdgeDef[] }
      ? { [I in keyof Es]: Es[I] extends AnyEdgeDef ? Tagged<Es[I]> : never }
      : O extends { kind: "many"; edge: infer E extends AnyEdgeDef }
        ? Record<string, PayloadOf<E>>
        : never;

/**
 * What every node's real output signature includes alongside its declared
 * shape (docs/design.md §3: "every node's real output signature includes
 * Failed<In>"), parameterized by the failing node's own input so a retry
 * node has something to re-emit, not just a notification something went
 * wrong. The runtime constructs this automatically when the membrane
 * rejects a payload or `Fn` throws (`reason` populated from whatever was
 * thrown); an author may also construct and return one explicitly for a
 * distinguishable failure mode — same opt-in shape as `env` on `Fn`.
 */
export interface Failed<In extends InputSpec> {
  input: InputPayload<In>;
  reason?: string;
}

/**
 * The naming convention a `single`-input node's `Failed<In>` routes
 * through — one synthesized edge per input edge, shared by every node
 * that fails on that same input (docs/design-history.md, "The runtime,
 * built narrow on purpose... `Failed<In>` routing"). `elaborate()`
 * synthesizes one of these per declared edge so a `.node` file can
 * declare `input: Failed_Todo`; `runtime.ts` logs a failure under this
 * same name — one convention, named once, used by both.
 */
export function failedEdgeName(inputEdgeName: string): string {
  return `Failed_${inputEdgeName}`;
}

/**
 * The naming convention an `allOf`-input node's `Failed<In>` routes
 * through — one synthesized edge per distinct declared combination of
 * edges, shared by every node whose `allOf: [...]` names that same set
 * (docs/design-history.md, "`any` built... every-input Failed<In> still
 * collects in failures"). Names are sorted before joining so the
 * synthesized edge is order-independent: `allOf(A, B)` and `allOf(B, A)`
 * resolve to the same `Failed_A_B`, matching `allOf`'s own readiness check
 * (a set of required edges, not an ordered sequence). `elaborate()`
 * synthesizes one of these per distinct combo actually declared; `runtime.ts`
 * logs a failure under this same name — one convention, named once, used
 * by both, mirroring `failedEdgeName`.
 */
export function failedAllOfEdgeName(edges: AnyEdgeDef[]): string {
  const sortedNames = edges.map((edge) => edge.name).sort();
  return `Failed_${sortedNames.join("_")}`;
}

/**
 * The reserved edge name a `many` output's collection is logged under
 * (docs/superpowers/specs/2026-09-26-spread-materializes-elements.md §1).
 * Reserved rather than synthesized as a real `.edge`, for the same reason
 * `membrane.ts`'s `assertManyOutput` exists: a bare keyed collection is not
 * a shape the type system can express as an edge payload. Keeping the
 * collection at all is what leaves the vectorized path reachable — a node
 * that wants the whole batch has something to read, and its retention cost
 * stays per batch rather than per row.
 *
 * Lives here rather than in `runtime.ts`, where it was first written,
 * because `gather` made it a convention two modules share: the runtime logs
 * under it, `lineage.ts`'s `gatherGroups` recognizes a barrier by it, and
 * `failedGatherEdgeName` below composes it. Three copies of the literal
 * `Many_` would be three places for it to drift.
 */
/**
 * How a gathered edge's entries are keyed, or `undefined` if they cannot be.
 *
 * An ordinary edge is keyed by its own declared `index`. A **synthesized failure
 * edge** has none — `Failed_X`'s fields are `{ input: X, reason }` — and yet
 * gathering one is exactly how a spread's failures get collected
 * (docs/superpowers/specs/2026-10-01-gather-settled.md §4). It is keyed by the
 * **failed element's** index, read through `input`.
 *
 * Better than keying by instance id, which was the alternative: it makes
 * `reportFailures`' collection use the *same keys* as `summarizeCorridor`'s, so
 * a reader can line the two up and ask which parcels failed. Keying by id would
 * answer "how many" and nothing else.
 */
export function gatherKey(edge: AnyEdgeDef): { via: "self" | "input"; field: string } | undefined {
  if (typeof edge.index === "string") return { via: "self", field: edge.index };
  const wrapped = (edge.fields as Record<string, unknown>).input;
  if (wrapped !== null && typeof wrapped === "object" && "fields" in wrapped) {
    const index = (wrapped as AnyEdgeDef).index;
    if (typeof index === "string") return { via: "input", field: index };
  }
  return undefined;
}

export function manyEdgeName(edgeName: string): string {
  return `Many_${edgeName}`;
}

/**
 * The naming convention a `gather`-input node's `Failed<In>` routes through
 * — `Failed_Many_Assessment` for `gather: Assessment`
 * (docs/superpowers/specs/2026-09-27-gather.md §4).
 *
 * **Deliberately not `Failed_<X>`**, which the spec's "the usual synthesized
 * edge" was written to mean and which is wrong. `Failed_X` is
 * `{ input: X, reason }` — one instance of X. A gather's `Failed<In>` carries
 * the *collection* it was holding when the group died, which is a different
 * shape, and logging it under `Failed_X` would put a collection in a field
 * declared to hold one entity: a payload nothing validates, since `append`
 * takes an edge name rather than a definition. A gather of X and an ordinary
 * node consuming X fail differently, so they route differently.
 *
 * Expressible as a real edge because a *field* may be `many` (`ManyEdgeDef`):
 * `{ input: { many: X }, reason }`. That is what makes this honest rather
 * than a cast — the same reason a bare collection could not be an edge in the
 * first place, working in weir's favour one layer down.
 */
export function failedGatherEdgeName(gatheredEdgeName: string): string {
  return failedEdgeName(manyEdgeName(gatheredEdgeName));
}

/**
 * A node's implementation. Context-free by default; a second `env`
 * parameter opts a node into seeing the envelope (docs/design.md §1). Not
 * a string reference — see spikes/ts-prototype/README.md for why a spike
 * represents "Fn reference" as a real typed function. May return `Failed<In>`
 * explicitly instead of its normal success value (above); an uncaught throw
 * is turned into one automatically by the membrane, not by `Fn` itself.
 */
export type Fn<In extends InputSpec, O extends OutputSpec> = (
  payload: InputPayload<In>,
  env?: Envelope,
) => OutputResult<O> | Failed<In> | Promise<OutputResult<O> | Failed<In>>;

/**
 * A single example in composition syntax, structurally: given -> expect
 * (docs/design.md §6). Composition-syntax parsing doesn't exist yet
 * (getting-started.md step 3); this is the typed equivalent.
 */
export interface Example<In extends InputSpec, O extends OutputSpec> {
  given: InputPayload<In>;
  expect: OutputResult<O>;
}

/**
 * One node of a property assertion's expression tree (docs/design.md §6;
 * docs/superpowers/specs/2026-09-23-property-assertions.md). Data, never
 * host code — §10 keeps `Fn` out of a declaration for exactly the reason a
 * property has to stay out too: a `.node` file is a data format, and a
 * predicate written in TypeScript could be neither authored in YAML,
 * fingerprinted structurally, nor carried across a change of host language.
 *
 * Key-as-discriminant, the same idiom `OutputSpec`'s `oneOf`/`allOf`/`many`
 * and `ManyEdgeDef`'s `many` already use. `implies` is a primitive rather
 * than sugar for `or(not(a), b)`: these are human-authored contracts, and
 * the conditional should read the way it was meant.
 */
export type PropertyExpr =
  | { lit: string | number | boolean | null }
  | { get: string }
  | { eq: [PropertyExpr, PropertyExpr] }
  | { ne: [PropertyExpr, PropertyExpr] }
  | { lt: [PropertyExpr, PropertyExpr] }
  | { lte: [PropertyExpr, PropertyExpr] }
  | { gt: [PropertyExpr, PropertyExpr] }
  | { gte: [PropertyExpr, PropertyExpr] }
  | { add: [PropertyExpr, PropertyExpr] }
  | { sub: [PropertyExpr, PropertyExpr] }
  // Non-empty by construction — `{ and: [] }`/`{ or: [] }` would be
  // vacuously true/false, a property that asserts nothing while always
  // passing. The generated JSON Schema already requires minItems: 1
  // (schema.ts); this is the same rule at the type level, for code-defined
  // nodes the schema never sees.
  | { and: [PropertyExpr, ...PropertyExpr[]] }
  | { or: [PropertyExpr, ...PropertyExpr[]] }
  | { not: PropertyExpr }
  | { implies: [PropertyExpr, PropertyExpr] };

/**
 * One named invariant a node's `Fn` must satisfy for every input
 * (docs/design.md §6). `description` is required for the same reason
 * `FieldDef` and `EdgeDef` require theirs — a property legible only by
 * reading its AST is precisely what that convention exists to prevent.
 */
export interface PropertyDecl {
  name: string;
  description: string;
  expr: PropertyExpr;
}

/**
 * A node declaration: name, input shape, output shape, Fn, and examples
 * (docs/getting-started.md step 2). Primitives only — a composite node's
 * body is a subgraph, which has no representation yet (topology/elaborator
 * are steps 3-4).
 */
export interface NodeDef<In extends InputSpec = InputSpec, O extends OutputSpec = OutputSpec> {
  name: string;
  label?: string;
  description?: string;
  input: In;
  output: O;
  fn: Fn<In, O>;
  /**
   * Names a host-supplied effect handler instead of a drafted
   * implementation (docs/superpowers/specs/2026-09-27-effects-are-data.md).
   * An effect node is where nondeterminism legitimately enters a program:
   * the runtime performs the effect, records the result as an ordinary edge
   * instance, and feeds that record back on replay rather than performing
   * again — which is what lets everything downstream of it stay pure.
   *
   * Everything else about such a node is unchanged. It is wired in a
   * `.topology` like any node, its input is asserted at the membrane, its
   * output is asserted against the declared edge, and lineage threads
   * through it. What differs is only where its behaviour comes from — and
   * that it is deliberately *not* checked by `weir verify`, since it is the
   * one place a program is supposed to be nondeterministic.
   */
  effect?: string;
  /**
   * The hash of the implementation source this NodeDef resolved to, set by
   * `resolveImplementationAt`. Absent on a bare `NodeDecl`, and absent for
   * an effect node, whose behaviour is a host handler rather than an
   * accepted artifact.
   *
   * The contract hash identifies *which contract* ran; this identifies
   * *which implementation of it*. Without it the version pin is
   * contract-shaped, and a replay cannot tell "this node is
   * nondeterministic" from "the implementation changed underneath".
   */
  implementationHash?: string;
  examples?: Example<In, O>[];
  /**
   * Invariants checked against generated inputs (docs/design.md §6).
   * Optional, unlike `examples` (which `schema.ts` requires and
   * `acceptImplementation` refuses a node without): a contract fully
   * pinned by its examples is a legitimate thing to declare, and a
   * mandatory property would produce ceremony rather than coverage.
   */
  properties?: PropertyDecl[];
  /**
   * Parameters baked in at elaboration time, e.g. an origin's literal or
   * expect's expected value (docs/design-history.md, "Generics: elaboration
   * monomorphizes"; examples/person-birthday/README.md decision 4).
   */
  closure?: ExpectClosure<In> | LiteralClosure<O>;
  /**
   * Envelope field values this node stamps onto everything it produces
   * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md §4).
   *
   * **Static**, and that is the whole of what this covers: trust is decided by
   * *which node ran* — a direct county fetch versus one through a commercial
   * proxy — not by what the node computed. A contribution derived from the
   * payload would mean `Fn` returning an envelope delta beside its result,
   * changing every implementation's signature for a case nothing has needed.
   *
   * Merged **after** propagation, so a node overrides what reached it.
   * Fingerprinted, because it changes what downstream sees — the same argument
   * that put `scope` in the hash.
   */
  contributes?: Record<string, unknown>;
  /**
   * `verb:edge:field` declarations (docs/design-history.md, "Identity is a
   * verified-once JWT; `scope` becomes a per-node declaration") — e.g.
   * `"read:Identity:sub"`. Optional, deliberately unlike `nullable`: a node
   * needing nothing beyond the thread's existing identity is a common,
   * legitimate default, not a footgun being papered over. Only `read:Identity:*`
   * resolves to anything today — `Identity` is the one edge this can name
   * (design-history.md); whether the mechanism generalizes to every edge, or
   * is `allOf:`'s field-narrowed sibling, is still open (open-questions.md).
   */
  scope?: string[];
}

type ExpectClosure<In extends InputSpec> = { expected: InputPayload<In> };
type LiteralClosure<O extends OutputSpec> = { literal: OutputResult<O> };

/**
 * A `.node` file's declared contract only — everything `NodeDef` has except
 * `fn` (docs/design.md §10: "`Fn` is host code, which a data format can't
 * and shouldn't hold... A `.node` file declares the contract only").
 */
export type NodeDecl<In extends InputSpec = InputSpec, O extends OutputSpec = OutputSpec> = Omit<
  NodeDef<In, O>,
  "fn"
>;
