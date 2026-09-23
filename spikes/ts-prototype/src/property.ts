/**
 * Evaluates a property assertion's expression tree against one
 * invocation's `{ input, output }` (docs/design.md §6;
 * docs/superpowers/specs/2026-09-23-property-assertions.md).
 *
 * Everything here that can only be a mistake in the *declaration* — a path
 * that doesn't resolve, a comparison between unorderable values, a
 * top-level expression that isn't boolean — throws immediately, naming
 * what went wrong. None of it is ever reported as a violation: a violation
 * means the implementation is wrong, a broken property means the contract
 * is wrong, and collapsing the two would point whoever is iterating at the
 * wrong artifact. Same distinction `fuzzNode` already draws between a node
 * failure and a generator defect.
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
 * Resolves a dotted path against `{ input, output }` — `input.age` for a
 * `single` input, `input.Person.age` for an `allOf` bag, `output.edge` and
 * `output.payload.x` for a tagged `oneOf` result. A path that runs off the
 * end of the data throws rather than yielding `undefined`, so a typo in a
 * contract can never quietly make a comparison false.
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
      throw new Error(`path "${path}" does not resolve: "${segment}" has nothing to read from (got ${describe(current)}).`);
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      throw new Error(`path "${path}" does not resolve: no "${segment}" here.`);
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

export function evaluateProperty(expr: PropertyExpr, scope: PropertyScope): unknown {
  if ("lit" in expr) return expr.lit;
  if ("get" in expr) return resolvePath(expr.get, scope);

  if ("eq" in expr) return isDeepStrictEqual(evaluateProperty(expr.eq[0], scope), evaluateProperty(expr.eq[1], scope));
  if ("ne" in expr) return !isDeepStrictEqual(evaluateProperty(expr.ne[0], scope), evaluateProperty(expr.ne[1], scope));

  if ("lt" in expr) return compare("lt", evaluateProperty(expr.lt[0], scope), evaluateProperty(expr.lt[1], scope));
  if ("lte" in expr) return compare("lte", evaluateProperty(expr.lte[0], scope), evaluateProperty(expr.lte[1], scope));
  if ("gt" in expr) return compare("gt", evaluateProperty(expr.gt[0], scope), evaluateProperty(expr.gt[1], scope));
  if ("gte" in expr) return compare("gte", evaluateProperty(expr.gte[0], scope), evaluateProperty(expr.gte[1], scope));

  if ("add" in expr) return asNumber("add", evaluateProperty(expr.add[0], scope)) + asNumber("add", evaluateProperty(expr.add[1], scope));
  if ("sub" in expr) return asNumber("sub", evaluateProperty(expr.sub[0], scope)) - asNumber("sub", evaluateProperty(expr.sub[1], scope));

  if ("and" in expr) return expr.and.every((operand) => asBoolean("and", evaluateProperty(operand, scope)));
  if ("or" in expr) return expr.or.some((operand) => asBoolean("or", evaluateProperty(operand, scope)));
  if ("not" in expr) return !asBoolean("not", evaluateProperty(expr.not, scope));

  // An implication is true whenever its antecedent is false — including
  // when nothing ever satisfies that antecedent, which is a real blind
  // spot this language does not yet detect (see the spec's Out of scope).
  if ("implies" in expr) {
    const antecedent = asBoolean("implies", evaluateProperty(expr.implies[0], scope));
    if (!antecedent) return true;
    return asBoolean("implies", evaluateProperty(expr.implies[1], scope));
  }

  // Exhaustiveness guard: PropertyExpr is a closed union, so a future
  // operator fails loudly here instead of silently evaluating to undefined.
  const unreachable: never = expr;
  throw new Error(`unrecognized property expression: ${JSON.stringify(unreachable)}`);
}

/** Evaluates one declared property, requiring a boolean result and naming the property in anything that goes wrong. */
export function checkProperty(property: PropertyDecl, scope: PropertyScope): boolean {
  let result: unknown;
  try {
    result = evaluateProperty(property.expr, scope);
  } catch (cause) {
    throw new Error(`property "${property.name}": ${(cause as Error).message}`);
  }
  if (typeof result !== "boolean") {
    throw new Error(`property "${property.name}" must evaluate to a boolean, got ${describe(result)}.`);
  }
  return result;
}
