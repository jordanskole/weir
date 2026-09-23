/**
 * One node invocation, whatever its InputSpec kind — the seam `fuzz.ts`
 * (generated cases) and `accept.ts` (declared examples) both run candidate
 * implementations through, extracted so the two can't drift apart
 * (docs/superpowers/specs/2026-09-10-acceptance-pipeline.md).
 *
 * Always through `membrane()`, never `nodeDef.fn` directly: input
 * assertion, envelope construction, `scope` narrowing and Failed<In>
 * conversion all live there, so a caller that bypassed it would be
 * exercising a different code path than the runtime actually runs
 * (docs/design.md §5).
 */

import { InMemoryLog, membrane } from "./membrane.js";
import type { Log } from "./membrane.js";
import type { NodeDef } from "./types.js";

/**
 * The same documented cast idiom `runtime.ts` already uses: `membrane()`'s
 * return type is a conditional on NodeDef's generic `In`, which TS can't
 * resolve from a plain, doubly-defaulted `NodeDef` even after
 * `nodeDef.input.kind` has been checked at the value level — a real TS
 * narrowing limitation, not a genuine call-shape ambiguity (the `kind`
 * branch checks it at runtime).
 */
type AnySingleInvoke = (payload: unknown, correlationId: string) => Promise<unknown>;
type AnyAllOfInvoke = (correlationId: string, log: Log) => Promise<unknown>;

/**
 * Runs `nodeDef` once against one input case. A `single`-input node takes
 * its payload directly; an `allOf`-input node resolves readiness against a
 * Log instead, so the case's bag (keyed by edge name — `InputPayload`'s own
 * allOf shape) is appended to a fresh `InMemoryLog` under `correlationId`
 * first. One log per invocation, never shared, so nothing leaks between
 * cases. Resolves to `undefined` for an `allOf` node whose bag is missing a
 * declared edge — `membrane()`'s own readiness semantics, passed through
 * unchanged rather than reinterpreted here. A non-object `input` (`null`,
 * `undefined`, or any other non-object — what an author-written example
 * whose `given` is malformed, e.g. `given:` with nothing after it in YAML,
 * parses to) is treated the same way: every declared edge simply reads as
 * missing from it, landing on the same not-ready `undefined` rather than
 * throwing a raw `TypeError` trying to index into it. This module has two
 * callers with two different trust levels for `input` — `fuzz.ts`'s is
 * always pre-validated generator output, `accept.ts`'s is arbitrary
 * author-written example data — and only the latter can ever hand this a
 * non-object, so the guard costs the former nothing.
 */
export async function invokeWithInput(
  nodeDef: NodeDef,
  input: unknown,
  correlationId: string,
): Promise<unknown> {
  if (nodeDef.input.kind === "single") {
    return await (membrane(nodeDef) as AnySingleInvoke)(input, correlationId);
  }

  const log = new InMemoryLog();
  const bag = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  for (const edge of nodeDef.input.edges) {
    log.append(edge.name, correlationId, bag[edge.name]);
  }
  return await (membrane(nodeDef) as AnyAllOfInvoke)(correlationId, log);
}
