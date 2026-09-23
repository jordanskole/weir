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
