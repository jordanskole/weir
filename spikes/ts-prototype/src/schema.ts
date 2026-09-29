/**
 * JSON Schema generation for `.field`/`.edge`/`.node`/`.topology` YAML —
 * the "schema-driven editor support" docs/design.md §10 promises,
 * generated mechanically from the same types (and the same
 * INTEGER_RANGES table) that already validate everything else via
 * defineField. Consumed by VS Code's YAML tooling (redhat.vscode-yaml /
 * yaml-language-server), not by weir's own runtime.
 *
 * What this can't express: cross-field relationships (min <= max,
 * enumValues excluding pattern/minLength/maxLength) — standard JSON Schema
 * has no clean way to compare sibling properties. Those checks still only
 * run for real in defineField/elaborate(); this schema catches the shape
 * mistakes a human makes while typing, not every rule. `topologySchema()`
 * has one more: it can check the nested `then:` map's *shape*, never that
 * a name it mentions is a real declared node — that needs the same
 * cross-file information `nodeSchema()` already can't reach without
 * `elaborate()`.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { INTEGER_RANGES, UNSIGNED_TYPES } from "./define.js";
import type { PropertyExpr, ScalarType } from "./types.js";

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
    // What kind of sensitive thing this field carries (design.md §7).
    // Deliberately an open string, like a topology's `zone`: §7 names PII and
    // financial as examples, and a closed enum is easy to add later and
    // impossible to remove once an ontology depends on a label this repo did
    // not think of.
    classification: { type: "string", minLength: 1 },
    // Envelope-only, and validated as *present* by `parseEnvelopeFile` rather
    // than here: an ordinary edge's field must not carry them, and the schema
    // is shared between the two.
    combine: { enum: ["meet", "join", "same"] },
    ordinal: { type: "boolean" },
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

/**
 * A field pinned to a single boolean value, for spread-with-override
 * (`edge CompletedTodo { ...Todo, is_complete: true }`) — a distinct field
 * kind, not a `bool` with a value attached: never `nullable`, never
 * `validations`, both meaningless on a fixed constant. Standalone, parallel
 * to `.node`'s existing `literal:`/`expected:` closure split, rather than a
 * modifier on `type: bool`.
 */
function literalFieldShape(): object {
  return {
    type: "object",
    required: ["literal"],
    properties: {
      literal: { type: "boolean" },
      label: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  };
}

/** Generates a JSON Schema for a standalone `.field` file. */
export function fieldSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir field",
    oneOf: [literalFieldShape(), fieldShape()],
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
        patternProperties: {
          "^\\.\\.\\..+$": { type: "null" },
        },
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
            { type: "boolean" },
            literalFieldShape(),
          ],
        },
      },
    },
    additionalProperties: false,
  };
}

const edgeName = { type: "string", minLength: 1 };
const edgeNameList = { type: "array", items: edgeName, minItems: 1 };

const EXPR_REF = { $ref: "#/$defs/propertyExpr" } as const;

// Kept in lockstep with types.ts's PropertyExpr union member-by-member — see
// this task's grammar-agreement note. Binary: exactly two operands. Variadic:
// one or more. `lit`, `get`, and `not` each get their own shape below.
const BINARY_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "add", "sub", "implies"] as const;
const VARIADIC_OPS = ["and", "or"] as const;

/**
 * A compile-time drift detector for the claim the comment above makes.
 * `PropertyExpr` (types.ts) and this file's own operator lists are two
 * independently-maintained descriptions of the same grammar — and unlike
 * every other schema this file generates, nothing at runtime ever checks
 * `nodeSchema()`'s output against real `.node` data (`elaborate.ts` never
 * validates against it; this schema is editor tooling only). So drift
 * between the two lists would otherwise be invisible until a human noticed
 * the editor accepting or rejecting the wrong thing. This turns that into a
 * type error `npm run typecheck` catches instead: `PropertyOp` is every key
 * any `PropertyExpr` member actually has; `ALL_OPS` is every key this file
 * declares; if either side names something the other doesn't, `_NoneMissing`
 * or `_NoneExtra` stops being `never`, and the `_drift` assignment below
 * fails to typecheck (`true` is no longer assignable to the resulting type).
 */
type PropertyOp = PropertyExpr extends infer T ? (T extends object ? keyof T : never) : never;
const ALL_OPS = [...BINARY_OPS, ...VARIADIC_OPS, "lit", "get", "not"] as const;
type _NoneMissing = Exclude<PropertyOp, (typeof ALL_OPS)[number]>;
type _NoneExtra = Exclude<(typeof ALL_OPS)[number], PropertyOp>;
// Not read at runtime — its only job is to exist and typecheck; see the
// comment above. `[_NoneMissing, _NoneExtra] extends [never, never]` is
// exactly the exhaustiveness claim this guard makes. `void`d rather than
// left as a bare unused binding, in case a future lint config's
// no-unused-vars would otherwise flag a leading-underscore const anyway.
const _drift: [_NoneMissing, _NoneExtra] extends [never, never] ? true : never = true;
void _drift;

/**
 * A single node in the property-expression grammar (docs/design.md §6,
 * PropertyExpr in types.ts) — self-referential, so defined once and
 * referenced by `$ref` (the standard JSON Schema mechanism for a recursive
 * grammar, supported by `redhat.vscode-yaml`'s bundled validator) rather than
 * inlined at every operand position. `oneOf` (not `anyOf`) plus
 * `additionalProperties: false` on every branch is what makes a two-operator
 * object like `{ lit: 1, get: "x" }` invalid: exactly one branch may match,
 * and each branch forbids every other operator's key.
 */
function propertyExprSchema(): Record<string, unknown> {
  const binary = { type: "array", items: EXPR_REF, minItems: 2, maxItems: 2 };
  const variadic = { type: "array", items: EXPR_REF, minItems: 1 };

  return {
    type: "object",
    oneOf: [
      { required: ["lit"], properties: { lit: { type: ["string", "number", "boolean", "null"] } }, additionalProperties: false },
      { required: ["get"], properties: { get: { type: "string" } }, additionalProperties: false },
      ...BINARY_OPS.map((op) => ({ required: [op], properties: { [op]: binary }, additionalProperties: false })),
      ...VARIADIC_OPS.map((op) => ({ required: [op], properties: { [op]: variadic }, additionalProperties: false })),
      { required: ["not"], properties: { not: EXPR_REF }, additionalProperties: false },
    ],
  };
}

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
 * no `fn`, name/input/output/examples/closure/properties. `input`/`output` reference
 * edges by bare name, resolved elsewhere (by the elaborator, not this
 * schema). `examples` is required and non-empty — per §6, examples are the
 * only thing that gives a same-shape-in-same-shape-out node (a "straight
 * pipe": one edge in, one out — see docs/design-history.md) any actual
 * content beyond its type signature; a node with none is indistinguishable
 * from a no-op.
 */
export function nodeSchema(): object {
  const objectPayload = { type: "object" };
  const inputShapeConditionals = [
    // single (bare-string input): exactly one tag, payload is an object.
    {
      if: { properties: { input: { type: "string" } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },
    // allOf (input position): several edges must all be present, each
    // tagged by name in given — mirrors allOf's own expect shape on the
    // output side.
    {
      if: { properties: { input: { type: "object", required: ["allOf"] } } },
      then: { properties: { examples: { items: { properties: { given: tagged(objectPayload) } } } } },
    },
    // anyOf (input position): one or more of several declared edges may
    // arrive, each independently — NOT the same "exactly one" guarantee
    // output's oneOf carries (docs/superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md).
    // Each individual example still tags exactly one edge, since it
    // demonstrates one shadow's behavior at a time — that's what taggedOne
    // below checks, unchanged from before this rename. Desugars into N
    // single-input nodes at elaboration time (elaborate.ts); this only
    // validates the authoring-level YAML shape.
    {
      if: { properties: { input: { type: "object", required: ["anyOf"] } } },
      then: { properties: { examples: { items: { properties: { given: taggedOne(objectPayload) } } } } },
    },
    // gather (input position): N instances of one edge, so exactly one tag
    // whose value is a keyed collection — the mirror image of `many` on the
    // output side below, because gather is spread's dual
    // (docs/superpowers/specs/2026-09-27-gather.md).
    {
      if: { properties: { input: { type: "object", required: ["gather"] } } },
      then: {
        properties: {
          examples: {
            items: { properties: { given: taggedOne({ type: "object", additionalProperties: objectPayload }) } },
          },
        },
      },
    },
  ];
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
              // A keyed collection, not an array — `many` has been keyed by
              // the referenced edge's own `index` since
              // docs/design-history.md's "`many` is a collection, keyed by
              // index, not an array", and `fuzz.ts`'s `assertManyOutput`
              // enforces that each entry sits under the key its own index
              // field names. This schema still said `array`, and nothing
              // noticed because nothing validated a declaration against it.
              properties: {
                expect: taggedOne({ type: "object", additionalProperties: objectPayload }),
              },
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
    required: ["input", "output"],
    properties: {
      label: { type: "string" },
      description: { type: "string" },
      /**
       * Names a host-supplied effect handler rather than a drafted
       * implementation. Added 2026-09-27: the parser learned `effect` when
       * effects were built and this schema did not, and nothing noticed —
       * because nothing validated a declaration against it. Wiring the
       * schema into elaboration is what surfaced the drift.
       */
      effect: { type: "string" },
      input: {
        oneOf: [
          edgeName,
          {
            type: "object",
            properties: { allOf: edgeNameList },
            required: ["allOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { anyOf: edgeNameList },
            required: ["anyOf"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { gather: edgeName },
            required: ["gather"],
            additionalProperties: false,
          },
        ],
      },
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
          // given's actual shape (single- vs multi-tagged) is set entirely by
          // inputShapeConditionals below, the same way expect's is set
          // entirely by outputShapeConditionals.
          properties: { given: {}, expect: {} },
          additionalProperties: false,
        },
      },
      // **An open object, since 2026-09-29.** `design.md` calls a closure
      // "parameters baked in at elaboration time", and until instantiation it
      // was a closed union of the two uses that happened to exist — `expect`'s
      // `{ expected }` and an origin's `{ literal }`. A `for:` row's parameters
      // are neither, and an author's are whatever their node's body needs.
      //
      // Those two remain the **conventions** and are what `contract.ts` and the
      // synthesized nodes emit; they are no longer schema-enforced, because a
      // schema cannot both admit arbitrary objects and constrain specific
      // shapes. Stated rather than discovered: this gives up typo detection on
      // `expected`, which used to be caught here. Attempting to keep both with
      // a three-branch `oneOf` is what a first version did, and it rejected
      // `examples/person-birthday` outright — `{ expected }` matched two
      // branches, which `oneOf` forbids, and reported it as a missing
      // `literal`.
      //
      // Not unguarded: an implementation reads `closure.expected`, so a typo
      // fails that node's own examples at the acceptance gate. It fails later
      // and with a worse message than it did.
      //
      // The one check kept, because it survives generalization: the two
      // conventions are mutually exclusive, so a closure declaring **both** is
      // contradictory whatever else it carries. An arbitrary parameter named
      // neither of them is unaffected.
      // Envelope field values this node stamps on what it produces. An open
      // object for the same reason `closure` is: the field names are the
      // author's envelope's, which this schema cannot know.
      contributes: { type: "object", minProperties: 1 },
      /**
       * `read:<Identity|Envelope>:<field>` declarations.
       *
       * Absent from this schema until 2026-09-29, so `scope` existed on the
       * type, was fingerprinted, and was documented in `design.md` §6 while
       * being **undeclarable in a `.node` file** — reachable only from a
       * programmatically constructed `NodeDef`, which in this repo meant tests.
       * Found building the declared envelope, which needs it from a file.
       *
       * Shape only here; that each entry *resolves* is checked at elaboration,
       * where the envelope table exists.
       */
      scope: { type: "array", items: { type: "string", minLength: 1 } },
      closure: {
        type: "object",
        minProperties: 1,
        not: { required: ["expected", "literal"] },
      },
      // JSON Schema's `properties` keyword, containing our field also named
      // `properties` — see this task's header note. Optional, unlike
      // `examples`: not added to `required` below, per the spec (a contract
      // fully pinned by its examples is legitimate).
      properties: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "description", "expr"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            expr: EXPR_REF,
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
    allOf: [
      // Examples are required, per §6: a node with none is indistinguishable
      // from a no-op, so they are the only thing giving a same-shape-in,
      // same-shape-out node content beyond its type signature.
      //
      // Except for an effect, where there is nothing to check them against:
      // its behaviour is a host handler that never passes the acceptance
      // gate, so a required example would be documentation the gate cannot
      // verify — which is the shape of claim this project keeps removing.
      { if: { not: { required: ["effect"] } }, then: { required: ["examples"] } },
      ...inputShapeConditionals,
      ...outputShapeConditionals,
    ],
    $defs: { propertyExpr: propertyExprSchema() },
  };
}

/**
 * Generates a JSON Schema for a `.topology` file — the nested `then:` map
 * (docs/design-history.md, "`.topology` built"): a node name is a key;
 * `then:` maps to the node names it feeds; a leaf is `null` or `{}`;
 * fan-out is several keys under one `then:`; a node fed by more than one
 * parent needs no special syntax, it just appears again under each
 * parent's own `then:`. Recursive via `$defs/topologyNode`, since the
 * nesting has no fixed depth. `then` is the only recognized key at any
 * level — matches `parseTopologyFile`'s own "only 'then' is a recognized
 * key" rejection (elaborate.ts).
 */
export function topologySchema(): object {
  const topologyNode = {
    oneOf: [
      { type: "null" },
      {
        type: "object",
        properties: { then: { type: "object", additionalProperties: { $ref: "#/$defs/topologyNode" } } },
        additionalProperties: false,
      },
    ],
  };
  const wiring = { type: "object", propertyNames: { minLength: 1 }, additionalProperties: { $ref: "#/$defs/topologyNode" } };

  // Every `.topology` declares a contract now
  // (docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md):
  // `output` + `terminals` + `wiring` for a root, plus `input` for a composite.
  // The bare-adjacency form — the whole document being the wiring — is gone,
  // which is why this schema no longer admits arbitrary top-level keys.
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Weir topology",
    type: "object",
    // Every topology declares the same four keys; whether it is an entry point
    // or a composite is decided by whether another topology references it, not
    // by its shape (2026-09-28-a-topology-declares-its-beginning.md §1).
    required: ["input", "output", "terminals", "wiring"],
    properties: {
      input: { oneOf: [edgeName, { type: "object", properties: { allOf: edgeNameList }, required: ["allOf"], additionalProperties: false }] },
      output: {
        oneOf: [
          edgeName,
          { type: "object", properties: { oneOf: edgeNameList }, required: ["oneOf"], additionalProperties: false },
          { type: "object", properties: { allOf: edgeNameList }, required: ["allOf"], additionalProperties: false },
          { type: "object", properties: { many: edgeName }, required: ["many"], additionalProperties: false },
        ],
      },
      terminals: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      // Where this topology runs (design.md §7). Optional, and deliberately not
      // validated against a vocabulary: §7's client/server/third-party/log are
      // examples rather than a closed set, and a closed set is easy to add and
      // impossible to remove.
      zone: { type: "string", minLength: 1 },
      wiring,
      // What this topology claims its composition does, in the same
      // `given`/`expect` form a node declares
      // (2026-09-28-a-topology-can-be-tested.md). Tagged by edge name on both
      // sides: `given` carries one tag, `expect` one per declared output edge.
      examples: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["given", "expect"],
          properties: { given: tagged({ type: "object" }), expect: tagged({ type: "object" }) },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
    $defs: { topologyNode },
  };
}

/**
 * Validating a hand-authored declaration against the schema that describes
 * it, before the hand-written parser touches it.
 *
 * These schemas existed and were used only by editor tooling and a drift
 * test. The parsers, meanwhile, destructure the keys they know and ignore
 * the rest — so `descriptoin:` or `validatoins:` was not an error, it was a
 * silently missing declaration, and `weir check` reported a tick. For a
 * language whose pitch is "will not compile", being wrong looking exactly
 * like being silent is the worst available failure mode, and it costs an
 * agent more than a person: a misspelled `validations` yields a green check
 * and a contract with no constraints.
 *
 * Every schema here already sets `additionalProperties: false`, so wiring
 * them in is what makes an unknown key an error rather than a shrug.
 *
 * Compiled against the schema *functions* rather than the committed
 * `schemas/*.json`, so elaboration depends on this module rather than on a
 * generated artifact — and so a parser that grows a key the schema does not
 * know fails loudly here instead of drifting quietly, which is how this gap
 * opened in the first place.
 */
const validators = new Map<string, ValidateFunction>();

function validatorFor(kind: DeclarationKind): ValidateFunction {
  let found = validators.get(kind);
  if (found === undefined) {
    const schema = { field: fieldSchema, edge: edgeSchema, node: nodeSchema, topology: topologySchema }[kind]();
    found = new Ajv2020({ strict: false }).compile(schema);
    validators.set(kind, found);
  }
  return found;
}

export type DeclarationKind = "field" | "edge" | "node" | "topology";

/**
 * Renders ajv's errors as something a person can act on.
 *
 * A `oneOf` failure reports every branch it tried, so an edge field with a
 * bad `type` produces six errors about `many`, `literal` and "must be
 * boolean" — accurate, and useless. The deepest `instancePath` is the one
 * that actually names the problem, and the structural keywords wrapping it
 * (`oneOf`, `anyOf`) describe the schema rather than the mistake.
 */
function renderErrors(errors: readonly ErrorObject[]): string {
  const meaningful = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf");
  const deepest = Math.max(...meaningful.map((e) => e.instancePath.length), 0);
  const focused = meaningful.filter((e) => e.instancePath.length === deepest);

  return [...new Set((focused.length > 0 ? focused : meaningful).map(describe))].join("; ");
}

function describe(e: ErrorObject): string {
  const where = e.instancePath === "" ? "" : `${e.instancePath} `;
  const params = e.params as { additionalProperty?: string; allowedValues?: unknown[] };
  // The default `additionalProperties` message omits the offending key, and
  // the default `enum` message omits what would have been allowed — the only
  // parts anyone needs in either case.
  if (params.additionalProperty !== undefined) return `${where}has unknown key "${params.additionalProperty}"`;
  if (params.allowedValues !== undefined) {
    return `${where}${e.message} (${params.allowedValues.join(", ")})`;
  }
  return `${where}${e.message}`;
}

/** Throws if `raw` does not satisfy the schema for `kind`, naming the path and what was wrong. */
export function assertDeclaration(kind: DeclarationKind, raw: unknown): void {
  const validate = validatorFor(kind);
  if (validate(raw)) return;
  throw new Error(`not a valid .${kind} declaration: ${renderErrors(validate.errors ?? [])}.`);
}
