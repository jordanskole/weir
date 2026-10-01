/**
 * Evaluates a property assertion's expression tree against one
 * invocation's `{ input, output }` (docs/design.md §6;
 * docs/superpowers/specs/2026-09-23-property-assertions.md).
 *
 * Everything here that can only be a mistake in the *declaration* — a path
 * that doesn't resolve, a comparison between unorderable values, a
 * top-level expression that isn't boolean — throws immediately, naming
 * what went wrong, and this module never reports any of it as a violation
 * itself: a violation means the implementation is wrong, a broken property
 * means the contract is wrong, and collapsing the two would point whoever
 * is iterating at the wrong artifact. Same distinction `fuzzNode` already
 * draws between a node failure and a generator defect.
 *
 * One exception, decided one layer up: `resolvePath`'s "doesn't resolve"
 * throw (`PropertyPathError`) carries which root it was rooted at, because
 * only the caller knows whether that root is contract-controlled or
 * candidate-controlled. `fuzzNode` (fuzz.ts) is the one place that acts on
 * that — an input-rooted failure is still a declaration bug and propagates
 * as the throw this module produced; an output-rooted one is reclassified
 * there into an ordinary property failure, since `output` is the
 * candidate's data, not the contract's.
 */

import { isDeepStrictEqual } from "node:util";
import type { PropertyDecl, PropertyExpr } from "./types.js";

export interface PropertyScope {
  input: unknown;
  output: unknown;
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

/**
 * Thrown when a `get` path fails to resolve, tagged with which root it was
 * rooted at (`"input"` or `"output"`) — the distinction the caller needs to
 * decide whether this is a declaration bug or a candidate-produced
 * violation (see this module's header, and fuzz.ts's property loop, which
 * is the one place that actually branches on `root`). Everywhere else this
 * is just an `Error`: declaration bugs still throw all the way out.
 */
export class PropertyPathError extends Error {
  readonly root: "input" | "output";

  constructor(message: string, root: "input" | "output") {
    super(message);
    this.name = "PropertyPathError";
    this.root = root;
  }
}

/**
 * Resolves a dotted path against `{ input, output }` — `input.age` for a
 * `single` input, `input.Person.age` for an `allOf` bag, `output.edge` and
 * `output.payload.x` for a tagged `oneOf` result. A path that runs off the
 * end of the data throws rather than yielding `undefined`, so a typo in a
 * contract can never quietly make a comparison false. Uses
 * `Object.hasOwn` rather than `in` so a path can never resolve to something
 * inherited off the prototype chain (`input.toString`) — `in` would let a
 * typo'd path silently resolve to a function instead of throwing.
 */
function resolvePath(path: string, scope: PropertyScope): unknown {
  const segments = path.split(".");
  const root = segments[0];
  if (root !== "input" && root !== "output") {
    throw new Error(`path "${path}" must start with "input" or "output".`);
  }

  let current: unknown = root === "input" ? scope.input : scope.output;
  for (const segment of segments.slice(1)) {
    if (typeof current !== "object" || current === null) {
      throw new PropertyPathError(
        `path "${path}" does not resolve: "${segment}" has nothing to read from (got ${describe(current)}).`,
        root,
      );
    }
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      throw new PropertyPathError(`path "${path}" does not resolve: no "${segment}" here.`, root);
    }
    current = record[segment];
  }
  return current;
}

type OrderingOp = "lt" | "lte" | "gt" | "gte";

function compareOrdered<T extends number | string>(op: OrderingOp, left: T, right: T): boolean {
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;
  if (op === "gt") return left > right;
  return left >= right;
}

/** Numbers order numerically, strings lexicographically — which is also the right ordering for `datetime`'s ISO-8601 values. Anything else is a declaration bug. */
function compare(op: OrderingOp, left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return compareOrdered(op, left, right);
  if (typeof left === "string" && typeof right === "string") return compareOrdered(op, left, right);
  throw new Error(`"${op}" needs two numbers or two strings, got ${describe(left)} and ${describe(right)}.`);
}

function asNumber(op: string, value: unknown): number {
  if (typeof value !== "number") throw new Error(`"${op}" needs a number, got ${describe(value)}.`);
  return value;
}

function asBoolean(op: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`"${op}" needs a boolean, got ${describe(value)}.`);
  return value;
}

function describeArity(value: unknown): string {
  return Array.isArray(value) ? `an array of length ${value.length}` : describe(value);
}

/**
 * Validates a binary operator's raw operand payload before recursing into
 * it — `{ eq: [...] }`'s array, unvalidated, is where a hand-authored
 * `NodeDef` (schema.ts's arity checks only run against YAML, never against
 * this) can smuggle in the wrong shape. Without this, a short or long
 * operand list reads to the caller as a raw, unrelated TypeError thrown deep
 * inside array indexing — see Finding 6.
 */
function binaryOperands(op: string, value: unknown): [PropertyExpr, PropertyExpr] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`"${op}" needs exactly two operands, got ${describeArity(value)}.`);
  }
  return value as [PropertyExpr, PropertyExpr];
}

/** Same as `binaryOperands`, for `and`/`or` — at least one operand, no upper bound. */
function variadicOperands(op: string, value: unknown): PropertyExpr[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"${op}" needs one or more operands, got ${describeArity(value)}.`);
  }
  return value as PropertyExpr[];
}

export function evaluateProperty(expr: PropertyExpr, scope: PropertyScope): unknown {
  // A non-object expression node (null, a bare string, ...) can never match
  // any operator branch below — caught here up front so it reads in this
  // module's own "unrecognized property expression" voice instead of
  // whatever TypeError `"lit" in expr` would throw on a non-object.
  if (typeof expr !== "object" || expr === null) {
    throw new Error(`unrecognized property expression: ${JSON.stringify(expr)}`);
  }

  if ("lit" in expr) return expr.lit;
  if ("get" in expr) return resolvePath(expr.get, scope);

  if ("eq" in expr) {
    const [a, b] = binaryOperands("eq", expr.eq);
    return isDeepStrictEqual(evaluateProperty(a, scope), evaluateProperty(b, scope));
  }
  if ("ne" in expr) {
    const [a, b] = binaryOperands("ne", expr.ne);
    return !isDeepStrictEqual(evaluateProperty(a, scope), evaluateProperty(b, scope));
  }

  if ("lt" in expr) {
    const [a, b] = binaryOperands("lt", expr.lt);
    return compare("lt", evaluateProperty(a, scope), evaluateProperty(b, scope));
  }
  if ("lte" in expr) {
    const [a, b] = binaryOperands("lte", expr.lte);
    return compare("lte", evaluateProperty(a, scope), evaluateProperty(b, scope));
  }
  if ("gt" in expr) {
    const [a, b] = binaryOperands("gt", expr.gt);
    return compare("gt", evaluateProperty(a, scope), evaluateProperty(b, scope));
  }
  if ("gte" in expr) {
    const [a, b] = binaryOperands("gte", expr.gte);
    return compare("gte", evaluateProperty(a, scope), evaluateProperty(b, scope));
  }

  if ("add" in expr) {
    const [a, b] = binaryOperands("add", expr.add);
    return asNumber("add", evaluateProperty(a, scope)) + asNumber("add", evaluateProperty(b, scope));
  }
  if ("sub" in expr) {
    const [a, b] = binaryOperands("sub", expr.sub);
    return asNumber("sub", evaluateProperty(a, scope)) - asNumber("sub", evaluateProperty(b, scope));
  }

  if ("and" in expr) return variadicOperands("and", expr.and).every((operand) => asBoolean("and", evaluateProperty(operand, scope)));
  if ("or" in expr) return variadicOperands("or", expr.or).some((operand) => asBoolean("or", evaluateProperty(operand, scope)));
  if ("not" in expr) return !asBoolean("not", evaluateProperty(expr.not, scope));

  // An implication is true whenever its antecedent is false — including
  // when nothing ever satisfies that antecedent, which is a real blind
  // spot this language does not yet detect (see the spec's Out of scope).
  if ("implies" in expr) {
    const [a, b] = binaryOperands("implies", expr.implies);
    const antecedent = asBoolean("implies", evaluateProperty(a, scope));
    if (!antecedent) return true;
    return asBoolean("implies", evaluateProperty(b, scope));
  }

  // Exhaustiveness guard: PropertyExpr is a closed union, so a future
  // operator fails loudly here instead of silently evaluating to undefined.
  const unreachable: never = expr;
  throw new Error(`unrecognized property expression: ${JSON.stringify(unreachable)}`);
}

/**
 * Evaluates one declared property, requiring a boolean result and naming
 * the property in anything that goes wrong. A `PropertyPathError` stays a
 * `PropertyPathError` (still carrying its `root`) even once renamed with
 * the property — that's what lets `fuzzNode`'s property loop tell an
 * output-rooted resolution failure apart from every other declaration bug
 * without re-parsing a message string.
 */
export function checkProperty(property: PropertyDecl, scope: PropertyScope): boolean {
  let result: unknown;
  try {
    result = evaluateProperty(property.expr, scope);
  } catch (cause) {
    const message = `property "${property.name}": ${(cause as Error).message}`;
    if (cause instanceof PropertyPathError) throw new PropertyPathError(message, cause.root);
    throw new Error(message);
  }
  if (typeof result !== "boolean") {
    throw new Error(`property "${property.name}" must evaluate to a boolean, got ${describe(result)}.`);
  }
  return result;
}

/**
 * Structural equality of two expressions, for the falsifiability check below.
 * JSON order-insensitivity is not needed: both operands come from the same
 * parser, so identical expressions serialize identically.
 */
function sameExpr(a: PropertyExpr, b: PropertyExpr): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Refuses a property that cannot fail (or cannot pass) because an `eq`/`ne`
 * compares an expression with itself.
 *
 * Found by rendering the blue-ribbon slice's properties as source
 * (docs/superpowers/specs/2026-10-01-the-deterministic-scaffold.md): two of its
 * six were self-comparisons —
 *
 *   "combined provenance is never stronger than either input"
 *      eq: [get output.provenance, get output.provenance]
 *   "the canonical PIN preserves every digit group of the source PIN"
 *      eq: [get output.pin, get output.pin]
 *
 * Both hold for every possible output, including one that claims the strongest
 * provenance in the lattice while both inputs carry the weakest. A property that
 * cannot fail is worse than no property, because the gate reports it as passing
 * and the name is read as a guarantee.
 *
 * Why it happens, and why refusing is the right answer rather than a nuisance:
 * in both cases the real property was inexpressible — the source PIN is inside an
 * opaque JSON string so there is no `input` path to compare against, and the
 * provenance lattice needs an ordering over `enumValues` that does not exist. The
 * author wrote a tautology rather than omit the property. Refusing it turns a
 * silent false green into a `weir check` failure that says which property, and
 * leaves the author to either express it or drop it.
 *
 * Deliberately narrow: only syntactically identical `eq`/`ne` operands. It does
 * not attempt to decide tautology in general, which is not the point — this is
 * the shape that actually occurred, three times, and it is decidable in one
 * comparison.
 */
export function assertFalsifiable(property: PropertyDecl): void {
  const expr = property.expr;
  const walk = (node: PropertyExpr): void => {
    if (typeof node !== "object" || node === null) return;

    if ("eq" in node && sameExpr(node.eq[0], node.eq[1])) {
      throw new Error(
        `property "${property.name}": \`eq\` compares an expression with itself, so it holds for every ` +
          `input and cannot fail. If the property you want is not expressible, drop it rather than ` +
          `asserting a tautology the gate will report as passing.`,
      );
    }
    if ("ne" in node && sameExpr(node.ne[0], node.ne[1])) {
      throw new Error(
        `property "${property.name}": \`ne\` compares an expression with itself, so it never holds.`,
      );
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach((v) => walk(v as PropertyExpr));
      else if (typeof value === "object" && value !== null) walk(value as PropertyExpr);
    }
  };
  walk(expr);
}

/**
 * Two input fields a node's declared properties require to be equal.
 * `{ edge: "StyleReport", field: "revision_id" }`.
 */
export interface InputFieldRef {
  edge: string;
  field: string;
}

/**
 * Groups of input fields that must carry the same value, derived from the
 * declared properties alone.
 *
 * WHY THIS EXISTS. `generateInputCases` builds an `allOf` bag one edge at a time,
 * so the fields come out independent — and the runtime never delivers such a bag,
 * because `allOf` inputs join by nearest common ancestor and therefore share
 * whatever their common ancestor gave them. The generator was manufacturing inputs
 * the runtime could not produce and the gate was holding implementations
 * responsible for them, twice over: blue-ribbon's `resolveIdentity` on `pin`, and
 * manuscript-review's `verdict` on `revision_id`. Both declarations *say* the
 * fields must agree, and say it in the property — so nothing new has to be
 * declared, it only has to be read.
 *
 * HOW. Collect every `eq` that the property **unconditionally requires**, union
 * their two operand paths into equivalence classes, then report each class's
 * `input.<Edge>.<field>` members where more than one distinct edge appears. The
 * union-find gives transitivity for free, which is what the real cases need:
 * `verdict` never compares its two inputs directly — it says each equals
 * `output.revision_id`, and the correlation follows through the output.
 *
 * UNCONDITIONALLY is the load-bearing word. An `eq` under `not` is required to be
 * *false*; under `or` it may be either; as an `implies` antecedent it is a guard
 * rather than a requirement. Only `and` preserves "this must hold", so the walk
 * descends through `and` and stops at everything else. Treating every `eq` as a
 * requirement would correlate fields a property deliberately allows to differ.
 */
export function correlatedInputFields(properties: readonly PropertyDecl[]): InputFieldRef[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const seen = parent.get(x);
    if (seen === undefined || seen === x) {
      parent.set(x, x);
      return x;
    }
    const root = find(seen);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  /** Only a bare `get` participates; an arithmetic operand is not an alias. */
  const pathOf = (expr: PropertyExpr): string | undefined =>
    typeof expr === "object" && expr !== null && "get" in expr ? expr.get : undefined;

  const requiredEqs = (expr: PropertyExpr): void => {
    if (typeof expr !== "object" || expr === null) return;
    if ("and" in expr) {
      for (const operand of expr.and) requiredEqs(operand);
      return;
    }
    if ("eq" in expr) {
      const a = pathOf(expr.eq[0]);
      const b = pathOf(expr.eq[1]);
      if (a !== undefined && b !== undefined) union(a, b);
    }
    // Everything else — or, not, implies, comparisons, arithmetic — is not an
    // unconditional equality and is deliberately not descended into.
  };

  for (const property of properties) requiredEqs(property.expr);

  const classes = new Map<string, Set<string>>();
  for (const path of parent.keys()) {
    const root = find(path);
    const members = classes.get(root) ?? new Set<string>();
    members.add(path);
    classes.set(root, members);
  }

  const groups: InputFieldRef[][] = [];
  for (const members of classes.values()) {
    const refs: InputFieldRef[] = [];
    for (const path of members) {
      // `input.<Edge>.<field>` exactly — an allOf bag is one level deep, and a
      // bare `input.<field>` is a single input with nothing to correlate against.
      const segments = path.split(".");
      if (segments.length === 3 && segments[0] === "input") {
        refs.push({ edge: segments[1]!, field: segments[2]! });
      }
    }
    const edges = new Set(refs.map((r) => r.edge));
    if (edges.size > 1) groups.push(refs);
  }
  return groups;
}
