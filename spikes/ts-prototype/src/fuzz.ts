/**
 * The structural fuzz harness (docs/superpowers/specs/2026-09-10-
 * generator-and-fuzz-harness.md) — runs generated inputs through a node's
 * real Fn via membrane() and checks the result is structurally either a
 * valid OutputSpec match or a valid Failed<In>. Also evaluates a node's
 * declared §6 property assertions (docs/superpowers/specs/2026-09-23-
 * property-assertions.md) against every generated case whose result was a
 * real output — never against a Failed<In> case, since a property has
 * nothing to check there — and reports any violation in `propertyFailures`,
 * plus the `realOutputs` count a caller needs to tell "every property held"
 * apart from "no property was ever exercised." This module only reports:
 * it doesn't decide pass/fail on a candidate, and in particular doesn't
 * enforce the vacuity guard itself (a node declaring properties with zero
 * `realOutputs` is not rejected here) — that verdict belongs to the
 * acceptance gate (accept.ts), which owns both example-checking and this
 * report.
 */

import { generateInputCases } from "./generate.js";
import { invokeWithInput } from "./invoke.js";
import { assertPayload } from "./membrane.js";
import { checkProperty, PropertyPathError } from "./property.js";
import { looksLikeFailed } from "./runtime.js";
import type { AnyEdgeDef, InputSpec, NodeDef, OutputSpec } from "./types.js";

/**
 * A bare `many`-output result is a keyed collection standing alone
 * (Record<string, PayloadOf<E>>, types.ts's OutputResult) — not a single
 * edge payload assertPayload can check directly, and not the same shape
 * as a `many` *field* nested inside another edge either (assertPayload's
 * own many-field branch expects an enclosing field to nest under). This
 * runs the same per-entry check — assert each entry against the edge,
 * confirm its own declared index field matches the key it's stored
 * under — adapted for a collection with no enclosing field.
 */
function assertManyOutput(edge: AnyEdgeDef, result: unknown): void {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`many output "${edge.name}": expected a collection object, got ${typeof result}.`);
  }
  if (edge.index === undefined) {
    throw new Error(`many output "${edge.name}": declares no index — a collection needs a real key.`);
  }
  const record = result as Record<string, unknown>;
  const errors: string[] = [];
  for (const [entryKey, entryValue] of Object.entries(record)) {
    try {
      const validated = assertPayload(edge, entryValue) as Record<string, unknown>;
      const actualKey = validated[edge.index];
      if (String(actualKey) !== entryKey) {
        errors.push(`["${entryKey}"]: keyed by "${entryKey}" but its own "${edge.index}" is "${String(actualKey)}"`);
      }
    } catch (cause) {
      errors.push(`["${entryKey}"]: ${(cause as Error).message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`many output "${edge.name}": ${errors.join("; ")}.`);
  }
}

function checkOutput(output: OutputSpec, result: unknown): void {
  if (output.kind === "single") {
    assertPayload(output.edge, result);
    return;
  }

  if (output.kind === "many") {
    assertManyOutput(output.edge, result);
    return;
  }

  if (output.kind === "oneOf") {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error(`oneOf output: expected a { edge, payload } object, got ${typeof result}.`);
    }
    const tagged = result as { edge?: unknown; payload?: unknown };
    const matchedEdge = output.edges.find((edge) => edge.name === tagged.edge);
    if (matchedEdge === undefined) {
      throw new Error(`oneOf output: "${String(tagged.edge)}" is not one of ${output.edges.map((e) => e.name).join(", ")}.`);
    }
    assertPayload(matchedEdge, tagged.payload);
    return;
  }

  // allOf
  if (!Array.isArray(result) || result.length !== output.edges.length) {
    throw new Error(`allOf output: expected exactly ${output.edges.length} tagged branch(es).`);
  }
  const tags = result as { edge?: unknown; payload?: unknown }[];
  for (const edge of output.edges) {
    const tagged = tags.find((t) => t.edge === edge.name);
    if (tagged === undefined) {
      throw new Error(`allOf output: missing a tagged branch for "${edge.name}".`);
    }
    assertPayload(edge, tagged.payload);
  }
}

/**
 * `JSON.stringify` falls back to `String(value)` when it can't render `value`
 * (a self-referential object from a broken Fn is the live case) — a harness
 * whose job is "did this come back garbage" shouldn't itself be defeated by
 * one class of garbage.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Whether `result` structurally satisfies `output`'s declared shape — never throws. */
export function resultMatchesOutput(output: OutputSpec, result: unknown): boolean {
  try {
    checkOutput(output, result);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `result` is a legitimate outcome for a node fuzzed against
 * `output` — either a real OutputSpec match, or Failed<In>'s shape
 * (always legitimate: design.md's "every node's real output signature is
 * one of {successes, Failed}").
 */
export function isAcceptableResult(output: OutputSpec, result: unknown): boolean {
  return resultMatchesOutput(output, result) || looksLikeFailed(result);
}

export interface FuzzReport {
  total: number;
  passed: number;
  failures: { input: unknown; error: string }[];
  /**
   * How many generated cases produced a result matching the declared
   * OutputSpec, as opposed to `Failed<In>`. Properties are only evaluated
   * against these — and a node declaring properties where this is zero has
   * had every property pass vacuously, which is what the acceptance gate's
   * guard exists to catch.
   */
  realOutputs: number;
  /**
   * `error` is populated when the failure came from a `PropertyPathError`
   * rooted at `output` — e.g. a `oneOf` branch whose payload doesn't carry
   * the field a property references (Finding 3, final whole-branch review):
   * that's candidate-controlled data disagreeing with the property's claim,
   * so it's reported here rather than thrown. It's absent for an ordinary
   * boolean-false violation, where the property evaluated cleanly and simply
   * didn't hold.
   */
  propertyFailures: { property: string; input: unknown; output: unknown; error?: string }[];
}

const DEFAULT_SEED = 42;
const DEFAULT_COUNT = 100;

/**
 * Validates one already-generated case against the declared InputSpec —
 * the same check membrane() itself runs at its own input boundary
 * (assertPayload, reused rather than reimplemented) — *before* handing the
 * case to membrane(). A failure here is a generator defect, not a node
 * outcome: it means generateInputCases produced a payload that doesn't
 * even satisfy the contract it was generated from, which should never
 * happen if the generator is correct. That's categorically different from
 * Fn coming back with a bad result (a node problem, recorded in
 * `failures`) — silently letting membrane() reject it at its own boundary
 * would just count the rejection as a "pass" (Finding 1: a broken
 * generator hiding a broken Fn behind a perfect-looking report), so this
 * throws loudly instead, naming the case and the validation that failed.
 */
function assertGeneratedCase(input: InputSpec, generatedCase: unknown, caseIndex: number): void {
  if (input.kind === "single") {
    try {
      assertPayload(input.edge, generatedCase);
    } catch (cause) {
      throw new Error(
        `fuzzNode: generated case ${caseIndex} is not valid input for "${input.edge.name}" — this is a generator defect, not a node outcome: ${(cause as Error).message}`,
      );
    }
    return;
  }
  const bag = generatedCase as Record<string, unknown>;
  for (const edge of input.edges) {
    try {
      assertPayload(edge, bag[edge.name]);
    } catch (cause) {
      throw new Error(
        `fuzzNode: generated case ${caseIndex} is not valid input for "${edge.name}" — this is a generator defect, not a node outcome: ${(cause as Error).message}`,
      );
    }
  }
}

/**
 * Runs `count` generated inputs through `nodeDef`'s real Fn, via
 * membrane() — the same boundary a node actually runs behind in the
 * runtime, reused rather than reimplemented. A generated case's result is
 * a failure only if it matches neither the declared OutputSpec nor
 * Failed<In> (isAcceptableResult); a deliberate Failed<In> return, or a
 * caught Fn throw (membrane() converts every throw to Failed<In> — never
 * lets one escape), are both legitimate, never reported as failures. A
 * generated case that membrane()'s own assertPayload would reject at the
 * input boundary is not a legitimate outcome to count either way (see
 * assertGeneratedCase) — it's thrown as a hard error instead, so it can
 * never masquerade as a `passed` case Fn was never actually exercised for.
 * Likewise a declared `many` output missing its edge's `index` is a
 * declaration bug (assertManyOutput would throw on every single case
 * otherwise, swallowed one-by-one into `failures`) — checked once, up
 * front, the same "throw immediately, don't collect as data error"
 * convention assertPayload already uses for the equivalent situation.
 */
export async function fuzzNode(
  nodeDef: NodeDef,
  opts?: { seed?: number; count?: number },
): Promise<FuzzReport> {
  if (nodeDef.output.kind === "many" && nodeDef.output.edge.index === undefined) {
    throw new Error(
      `fuzzNode: output edge "${nodeDef.output.edge.name}" declares no index — a many output needs a real key.`,
    );
  }

  const seed = opts?.seed ?? DEFAULT_SEED;
  const count = opts?.count ?? DEFAULT_COUNT;
  const cases = generateInputCases(nodeDef.input, seed, count);

  const failures: FuzzReport["failures"] = [];
  const propertyFailures: FuzzReport["propertyFailures"] = [];
  const properties = nodeDef.properties ?? [];
  let passed = 0;
  let realOutputs = 0;

  for (const [i, input] of cases.entries()) {
    assertGeneratedCase(nodeDef.input, input, i);
    const { result } = await invokeWithInput(nodeDef, input, `fuzz-${i}`);
    if (isAcceptableResult(nodeDef.output, result)) {
      passed += 1;
    } else {
      failures.push({
        input,
        error: `result matched neither the declared output nor Failed<In>: ${safeStringify(result)}`,
      });
    }

    if (resultMatchesOutput(nodeDef.output, result)) {
      realOutputs += 1;
      for (const property of properties) {
        try {
          if (!checkProperty(property, { input, output: result })) {
            propertyFailures.push({ property: property.name, input, output: result });
          }
        } catch (cause) {
          // An input-rooted PropertyPathError (or any other checkProperty
          // throw) is still a declaration bug — the contract's own input
          // shape doesn't back the path it names, so it stays a hard
          // failure of fuzzNode itself, same as every other throw path here.
          // An output-rooted one is different: `result` is candidate-
          // controlled data (this is true even for a `single` output — see
          // property.ts's header), so a path that doesn't resolve there
          // means the candidate produced a shape the property's claim is
          // false of. That's a violation to report, not a declaration to
          // blame — reported here exactly like an ordinary boolean-false
          // property failure, just with `error` naming why.
          if (cause instanceof PropertyPathError && cause.root === "output") {
            propertyFailures.push({ property: property.name, input, output: result, error: cause.message });
            continue;
          }
          throw cause;
        }
      }
    }
  }

  return { total: count, passed, failures, realOutputs, propertyFailures };
}
