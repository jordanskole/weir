/**
 * Schema hashing for drift detection.
 *
 * Produces a deterministic SHA-256 fingerprint of an EdgeDef's structural
 * shape. Only structural fields are included — changes to description, unit,
 * or sourceKey do not affect the hash. `validations` (min/max/minLength/
 * maxLength/pattern) is structural: it changes what values are valid, same
 * as enumValues. A compound (nested-edge) field fingerprints as that edge's own
 * fingerprint, recursively — a change anywhere in a nested edge's shape changes
 * the parent's hash too, same as a change to a scalar field would. A many-of-
 * compound field (`{ many: E }`) fingerprints the same way, tagged separately.
 * Every edge instance in the log carries the schema hash of the definition it
 * was written under (docs/design.md §5);
 * replay compares recorded hash to current definition and either migrates
 * through a declared rule or refuses.
 *
 * Ported from @bankql/schema's hashDataset — see docs/design-history.md,
 * "Prior art: bankql already proves the edge half."
 *
 * Uses the Web Crypto API so the same implementation runs in both Node
 * (>=20) and modern browsers.
 */

import type {
  AnyEdgeDef,
  FieldDef,
  InputSpec,
  LiteralFieldDef,
  ManyEdgeDef,
  NodeDecl,
  OutputSpec,
  PropertyDecl,
  PropertyExpr,
} from "./types.js";

interface ScalarFieldFingerprint {
  type: string;
  measure?: string;
  format?: string;
  enumValues?: string[];
  relation?: { edge: string; field: string; cardinality: string };
  validations?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
  nullable?: true;
}

/**
 * A compound (nested-edge) field fingerprints as its own edge's fingerprint,
 * recursively; a many-of-compound field fingerprints the same way, tagged
 * separately so "one Task" and "many Task" never collide.
 */
type FieldFingerprint =
  | ScalarFieldFingerprint
  | { edge: EdgeFingerprint }
  | { many: EdgeFingerprint }
  | { literal: boolean };

interface EdgeFingerprint {
  name: string;
  index?: string;
  fields: Record<string, FieldFingerprint>;
}

function fingerprint(edge: AnyEdgeDef): EdgeFingerprint {
  const fields: Record<string, FieldFingerprint> = {};

  for (const key of Object.keys(edge.fields).sort()) {
    const value = edge.fields[key] as FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef;

    if ("many" in value) {
      fields[key] = { many: fingerprint(value.many) };
      continue;
    }

    if ("fields" in value) {
      fields[key] = { edge: fingerprint(value) };
      continue;
    }

    if ("literal" in value) {
      fields[key] = { literal: value.literal };
      continue;
    }

    const f = value;
    const entry: ScalarFieldFingerprint = { type: f.type };
    if (f.measure !== undefined) entry.measure = f.measure;
    if (f.format !== undefined) entry.format = f.format;
    if (f.enumValues !== undefined) entry.enumValues = [...f.enumValues].sort();
    if (f.relation !== undefined) {
      entry.relation = {
        edge: f.relation.edge,
        field: f.relation.field,
        cardinality: f.relation.cardinality,
      };
    }
    const v = f.validations as
      | { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string }
      | undefined;
    if (v !== undefined) {
      const validations: ScalarFieldFingerprint["validations"] = {};
      if (v.min !== undefined) validations.min = v.min;
      if (v.max !== undefined) validations.max = v.max;
      if (v.minLength !== undefined) validations.minLength = v.minLength;
      if (v.maxLength !== undefined) validations.maxLength = v.maxLength;
      if (v.pattern !== undefined) validations.pattern = v.pattern;
      if (Object.keys(validations).length > 0) entry.validations = validations;
    }
    if ("nullable" in f && f.nullable === true) entry.nullable = true;
    fields[key] = entry;
  }

  return {
    name: edge.name,
    ...(edge.index !== undefined && { index: edge.index }),
    fields,
  };
}

export interface SchemaHash {
  /** Full 64-character SHA-256 hex digest. */
  hash: string;
  /** First 8 characters — suitable for envelopes, filenames, logs, and display. */
  short: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hashes an implementation's source text — the identity the contract hash
 * does not carry.
 *
 * `fingerprintNode` covers a node's *declaration*, so two different
 * implementations of one contract hash identically and are stored at the
 * same path (`{node}/{short(contractHash)}.ts`). Re-accepting overwrites,
 * and a replay then resolves whatever is on disk now rather than what ran
 * — which `readme.md` nonetheless describes as replaying "against exactly
 * that one" (docs/open-questions.md, "The version pin pins the contract,
 * not the implementation").
 *
 * Source text rather than the parsed function, because that is what was
 * accepted and what can be compared later without running anything. It is
 * deliberately sensitive to formatting: a reformatted implementation is a
 * different artifact from the one the gate accepted, and saying so is
 * cheaper than being wrong about it.
 */
export async function hashSource(source: string): Promise<SchemaHash> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hash = toHex(digest);
  return { hash, short: hash.slice(0, 8) };
}

export async function hashEdge(edge: AnyEdgeDef): Promise<SchemaHash> {
  const json = JSON.stringify(fingerprint(edge));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = toHex(digest);
  return { hash, short: hash.slice(0, 8) };
}

export async function hashEdges(edges: AnyEdgeDef[]): Promise<Record<string, SchemaHash>> {
  const entries = await Promise.all(
    edges.map(async (e) => [e.name, await hashEdge(e)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * A node's structural fingerprint, one layer up from `EdgeFingerprint`
 * (docs/design.md §10: a new implementation file is generated "when the
 * node's schema hash no longer matches the one an accepted implementation
 * exists for"). Only the contract's shape counts — description/label are
 * excluded, same as `EdgeFingerprint`. `closure` is included: a baked-in
 * literal (an `expect` node's expected value, an origin's literal) changes
 * what the implementation must actually compute, even though it doesn't
 * change `input`/`output`'s types. `examples` is excluded on purpose —
 * examples are the acceptance test suite *for* a contract, not part of the
 * contract itself (§10: "written once it passes both its examples and
 * generated property cases" — examples gate acceptance, they don't define
 * the hash being accepted against). `scope` is included for the opposite
 * reason: it's behavioural, not a verification artifact. `membrane` narrows
 * `identity` by it, so it decides what the implementation actually receives
 * — widen or change a scope and the previously accepted implementation is
 * being asked to compute from different data.
 */
interface NodeFingerprint {
  name: string;
  input: InputSpecFingerprint;
  output: OutputSpecFingerprint;
  closure?: unknown;
  scope?: string[];
  properties?: { name: string; expr: PropertyExpr }[];
}

type InputSpecFingerprint =
  | { kind: "single"; edge: EdgeFingerprint }
  | { kind: "allOf"; edges: EdgeFingerprint[] };

type OutputSpecFingerprint =
  | { kind: "single"; edge: EdgeFingerprint }
  | { kind: "oneOf"; edges: EdgeFingerprint[] }
  | { kind: "allOf"; edges: EdgeFingerprint[] }
  | { kind: "many"; edge: EdgeFingerprint };

/** Sorted by name, same "independent of declaration order" rule as an edge's own fields. */
function fingerprintEdgeList(edges: AnyEdgeDef[]): EdgeFingerprint[] {
  return [...edges].sort((a, b) => a.name.localeCompare(b.name)).map(fingerprint);
}

function fingerprintInput(input: InputSpec): InputSpecFingerprint {
  if (input.kind === "single") return { kind: "single", edge: fingerprint(input.edge) };
  return { kind: "allOf", edges: fingerprintEdgeList(input.edges) };
}

function fingerprintOutput(output: OutputSpec): OutputSpecFingerprint {
  if (output.kind === "single") return { kind: "single", edge: fingerprint(output.edge) };
  if (output.kind === "many") return { kind: "many", edge: fingerprint(output.edge) };
  return { kind: output.kind, edges: fingerprintEdgeList(output.edges) };
}

/**
 * A duplicate property name makes two things ambiguous at once: this
 * module's own sort (see `fingerprintProperties` below) and a violation
 * report, which identifies a property by name alone. Exported so any other
 * entry point that hands a node's properties to an outside consumer — today
 * that's `contract.ts`'s `exportContract`, a separate public entry point
 * `acceptImplementation` never reaches (it hashes first, so this guard
 * already runs) but that can otherwise produce a `SealedContract` carrying
 * the same unreadable duplicate — can reuse the identical check rather than
 * re-implementing it.
 */
export function assertUniquePropertyNames(properties: PropertyDecl[]): void {
  const seen = new Set<string>();
  for (const property of properties) {
    if (seen.has(property.name)) {
      throw new Error(
        `Duplicate property name "${property.name}" — property names must be unique within a node.`,
      );
    }
    seen.add(property.name);
  }
}

/**
 * Properties are sorted by name before fingerprinting: two nodes declaring
 * the same properties in a different order assert the same contract, so
 * reordering a list in a `.node` file must not invalidate a perfectly good
 * implementation. That makes `name` load-bearing, so a duplicate is a
 * declaration bug — it would make the sort ambiguous and make a violation
 * report (which identifies a property by name) unreadable.
 *
 * `description` is excluded, consistent with this module already excluding
 * cosmetic fields (description, unit, sourceKey) from every other
 * fingerprint it computes.
 */
function fingerprintProperties(properties: PropertyDecl[]): { name: string; expr: PropertyExpr }[] {
  assertUniquePropertyNames(properties);

  return [...properties]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((property) => ({ name: property.name, expr: property.expr }));
}

/**
 * Sorted for the same reason properties are — declaration order carries no
 * meaning, so reordering a scope list must not invalidate an accepted
 * implementation. Duplicates de-duplicate rather than throw: unlike a
 * duplicate property name, a repeated scope is redundant but unambiguous
 * (narrowing to the same field twice is that one narrowing), so there's
 * nothing for a declarer to disambiguate.
 */
function fingerprintScope(scope: string[]): string[] {
  return [...new Set(scope)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function fingerprintNode(node: NodeDecl): NodeFingerprint {
  return {
    name: node.name,
    input: fingerprintInput(node.input),
    output: fingerprintOutput(node.output),
    ...(node.closure !== undefined && { closure: node.closure }),
    ...(node.scope !== undefined &&
      node.scope.length > 0 && { scope: fingerprintScope(node.scope) }),
    ...(node.properties !== undefined &&
      node.properties.length > 0 && { properties: fingerprintProperties(node.properties) }),
  };
}

export async function hashNode(node: NodeDecl): Promise<SchemaHash> {
  const json = JSON.stringify(fingerprintNode(node));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = toHex(digest);
  return { hash, short: hash.slice(0, 8) };
}

/**
 * Assert that an edge matches an expected hash.
 * Throws if the hash has changed — useful in tests or replay to catch
 * accidental schema drift.
 */
export async function assertEdgeHash(edge: AnyEdgeDef, expectedShort: string): Promise<void> {
  const { short, hash } = await hashEdge(edge);
  if (short !== expectedShort) {
    throw new Error(
      `Schema drift detected for edge "${edge.name}": ` +
        `expected hash "${expectedShort}", got "${short}" (full: ${hash}). ` +
        `Update the expected hash or roll back the schema change.`,
    );
  }
}
