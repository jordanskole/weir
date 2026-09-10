/**
 * The structural fuzz harness (docs/superpowers/specs/2026-09-10-
 * generator-and-fuzz-harness.md) — runs generated inputs through a node's
 * real Fn via membrane() and checks the result is structurally either a
 * valid OutputSpec match or a valid Failed<In>. Never checks semantic
 * correctness: no property-assertion mechanism exists yet (design.md §6's
 * "∀ p . ..." properties), only "did this crash or come back garbage."
 */

import { assertPayload, InMemoryLog, membrane } from "./membrane.js";
import { generateInputCases } from "./generate.js";
import { looksLikeFailed } from "./runtime.js";
import type { Log } from "./membrane.js";
import type { AnyEdgeDef, NodeDef, OutputSpec } from "./types.js";

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
 * Same documented cast idiom runtime.ts's own AnySingleInvoke/AnyAllOfInvoke
 * use (and the same plain, doubly-defaulted `NodeDef` runtime.ts's own
 * `program.nodes: Record<string, NodeDef>` already stores its erased node
 * declarations as): membrane()'s return type is a conditional on NodeDef's
 * generic In, which TS can't resolve here even after nodeDef.input.kind is
 * checked at the value level — a real TS narrowing limitation, not a
 * genuine call-shape ambiguity (the `kind` branch itself checks it at
 * runtime).
 */
type AnySingleInvoke = (payload: unknown, correlationId: string) => Promise<unknown>;
type AnyAllOfInvoke = (correlationId: string, log: Log) => Promise<unknown>;

/**
 * Runs `count` generated inputs through `nodeDef`'s real Fn, via
 * membrane() — the same boundary a node actually runs behind in the
 * runtime, reused rather than reimplemented. A generated case's result is
 * a failure only if it matches neither the declared OutputSpec nor
 * Failed<In> (isAcceptableResult); a deliberate Failed<In> return, or a
 * caught Fn throw (membrane() converts every throw to Failed<In> — never
 * lets one escape), are both legitimate, never reported as failures.
 */
export async function fuzzNode(
  nodeDef: NodeDef,
  opts?: { seed?: number; count?: number },
): Promise<FuzzReport> {
  const seed = opts?.seed ?? DEFAULT_SEED;
  const count = opts?.count ?? DEFAULT_COUNT;
  const cases = generateInputCases(nodeDef.input, seed, count);

  const failures: FuzzReport["failures"] = [];
  let passed = 0;

  if (nodeDef.input.kind === "single") {
    const invoke = membrane(nodeDef) as AnySingleInvoke;
    for (const [i, input] of cases.entries()) {
      const result = await invoke(input, `fuzz-${i}`);
      if (isAcceptableResult(nodeDef.output, result)) {
        passed += 1;
      } else {
        failures.push({ input, error: `result matched neither the declared output nor Failed<In>: ${JSON.stringify(result)}` });
      }
    }
  } else {
    const invoke = membrane(nodeDef) as AnyAllOfInvoke;
    for (const [i, bagCase] of cases.entries()) {
      const correlationId = `fuzz-${i}`;
      const log = new InMemoryLog();
      const bag = bagCase as Record<string, unknown>;
      for (const edge of nodeDef.input.edges) {
        log.append(edge.name, correlationId, bag[edge.name]);
      }
      const result = await invoke(correlationId, log);
      if (isAcceptableResult(nodeDef.output, result)) {
        passed += 1;
      } else {
        failures.push({ input: bagCase, error: `result matched neither the declared output nor Failed<In>: ${JSON.stringify(result)}` });
      }
    }
  }

  return { total: count, passed, failures };
}
