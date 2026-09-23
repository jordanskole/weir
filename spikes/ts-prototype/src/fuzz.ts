/**
 * The structural fuzz harness (docs/superpowers/specs/2026-09-10-
 * generator-and-fuzz-harness.md) — runs generated inputs through a node's
 * real Fn via membrane() and checks the result is structurally either a
 * valid OutputSpec match or a valid Failed<In>. Never checks semantic
 * correctness: no property-assertion mechanism exists yet (design.md §6's
 * "∀ p . ..." properties), only "did this crash or come back garbage."
 */

import { generateInputCases } from "./generate.js";
import { invokeWithInput } from "./invoke.js";
import { assertPayload } from "./membrane.js";
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
  let passed = 0;

  for (const [i, input] of cases.entries()) {
    assertGeneratedCase(nodeDef.input, input, i);
    const result = await invokeWithInput(nodeDef, input, `fuzz-${i}`);
    if (isAcceptableResult(nodeDef.output, result)) {
      passed += 1;
    } else {
      failures.push({
        input,
        error: `result matched neither the declared output nor Failed<In>: ${safeStringify(result)}`,
      });
    }
  }

  return { total: count, passed, failures };
}
