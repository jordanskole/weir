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
export type ScalarType =
  | "utf8"
  | "bool"
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "f32"
  | "f64"
  | "datetime";

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
 * optional/absent key — same call already made for `Envelope.causationId`
 * (docs/design-history.md): a nullable field forces a caller to handle the
 * null, an absent key doesn't force anything.
 */
export type FieldDef<T extends ScalarType = ScalarType, N extends boolean = boolean> = T extends "bool"
  ? FieldDefBase<T>
  : FieldDefBase<T> & { nullable: N };

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
  F extends Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef> = Record<string, FieldDef>,
> {
  name: string;
  label: string;
  description: string;
  /** Field that uniquely identifies an instance, where one exists. */
  index?: string;
  fields: F;
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
export type AnyEdgeDef = EdgeDef<Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef>>;

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
export type Payload<F extends Record<string, FieldDef | AnyEdgeDef | ManyEdgeDef>> = {
  [K in keyof F]: F[K] extends FieldDef<infer T, infer N>
    ? N extends true
      ? ScalarTsType<T> | null
      : ScalarTsType<T>
    : F[K] extends ManyEdgeDef<infer E>
      ? PayloadOf<E>[]
      : F[K] extends AnyEdgeDef
        ? PayloadOf<F[K]>
        : never;
};

/** The runtime payload shape of an edge definition. */
export type PayloadOf<E extends AnyEdgeDef> = Payload<E["fields"]>;

/**
 * The principal an invocation runs as — the "on behalf of" (docs/design-history.md,
 * "Identity is the actor, edges are the resource"). Every invocation has one, even a
 * system/scheduler-triggered one; there is no identity-less execution. Placeholder
 * shape until the actor model is designed — `Unit`'s idiom, not `{}` (which types
 * as "any non-nullish value", not "empty object").
 */
export type Identity = Record<string, never>;

/**
 * Per-invocation metadata wrapping every edge instance (docs/design.md §1).
 * A node's Fn does not see this by default; a second `env` parameter is
 * what opts a node into being context-dependent (routers, dedupers).
 */
export interface Envelope {
  id: string;
  correlationId: string;
  causationId: string | null;
  timestamp: string;
  step: number;
  identity: Identity;
  schemaHash: string;
}

/**
 * A node's input shape (docs/design.md §5) — a single edge, or several via
 * `every`. `every` is a readiness condition the membrane resolves against a
 * `correlation_id`'s per-edge-type logs, never a synchronous join or an
 * accumulator (docs/design-history.md, "The membrane"). Mirrors OutputSpec's
 * "kind is the discriminant" idiom on purpose — `single` here is the same
 * shape `single()` already produces for OutputSpec, so the same helper
 * serves both.
 */
export type InputSpec =
  | { kind: "single"; edge: AnyEdgeDef }
  | { kind: "every"; edges: AnyEdgeDef[] };

/**
 * The payload shape Fn receives for a given InputSpec: the edge's own
 * payload for `single`, a bag keyed by edge name for `every` — matching the
 * `given`/`expect` name-as-key tagging convention already decided for
 * `.node` examples (docs/design-history.md).
 */
export type InputPayload<I extends InputSpec> = I extends {
  kind: "single";
  edge: infer E extends AnyEdgeDef;
}
  ? PayloadOf<E>
  : I extends { kind: "every"; edges: infer Es extends AnyEdgeDef[] }
    ? { [K in Es[number]["name"]]: PayloadOf<Extract<Es[number], { name: K }>> }
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
        ? PayloadOf<E>[]
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
  examples?: Example<In, O>[];
  /**
   * Parameters baked in at elaboration time, e.g. an origin's literal or
   * expect's expected value (docs/design-history.md, "Generics: elaboration
   * monomorphizes"; examples/person-birthday/README.md decision 4).
   */
  closure?: ExpectClosure<In> | LiteralClosure<O>;
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
