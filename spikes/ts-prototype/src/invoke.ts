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

import { membrane } from "./membrane.js";
import type { InvocationContext } from "./membrane.js";
import type { Envelope, NodeDef } from "./types.js";

/**
 * The same documented cast idiom `runtime.ts` already uses: `membrane()`'s
 * argument and return types are a conditional on NodeDef's generic `In`,
 * which TS can't resolve from a plain, doubly-defaulted `NodeDef` even
 * after `nodeDef.input.kind` has been checked at the value level — a real
 * TS narrowing limitation, not a genuine call-shape ambiguity (the `kind`
 * branch checks it at runtime). Both call shapes carry the same trailing
 * `context` argument `membrane.ts`'s real `MembraneArgs` accepts —
 * `InvocationContext`'s `identity` is typed `Partial`, matching
 * `Envelope.identity` itself, because replay's caller (see
 * `replayInvocation`) can only ever supply a previously *narrowed*
 * identity, never the full claims set.
 */
type AnySingleInvoke = (
  nodeDef: NodeDef,
  payload: unknown,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope }>;
type AnyAllOfInvoke = (
  nodeDef: NodeDef,
  bag: Record<string, unknown>,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope }>;

/**
 * Runs `nodeDef` once against one input case. A `single`-input node takes
 * its payload directly; an `allOf`-input node takes its bag directly too
 * (keyed by edge name — `InputPayload`'s own allOf shape) — the membrane no
 * longer resolves that bag from a Log (docs/superpowers/specs/
 * 2026-09-25-allof-joins-by-lineage.md §5), so there is no readiness check
 * left here to stage one against; the bag goes straight through. A
 * non-object `input` (`null`, `undefined`, or any other non-object — what
 * an author-written example whose `given` is malformed, e.g. `given:` with
 * nothing after it in YAML, parses to) is normalized to `{}` rather than
 * throwing a raw `TypeError` trying to index into it — every declared edge
 * then simply reads as missing, which `membrane()`'s `assertPayload` call
 * rejects the same way it rejects any other incomplete bag, landing on
 * `Failed<In>` rather than a bare exception. This module has two callers
 * with two different trust levels for `input` — `fuzz.ts`'s is always
 * pre-validated generator output, `accept.ts`'s is arbitrary author-written
 * example data — and only the latter can ever hand this a non-object, so
 * the guard costs the former nothing.
 *
 * `context.identity` is optional and passed straight through to
 * `membrane()` — omitted, a node resolves under `SYSTEM_IDENTITY` exactly
 * as before (membrane.ts's documented default). `replay.ts` is the caller
 * that supplies one, re-feeding a recorded `Envelope.identity` back in so a
 * scoped node's replayed result reflects who actually invoked it rather
 * than always falling through to the system default.
 *
 * `context.step` is threaded the same way, for the same reason: optional,
 * passed straight through to `membrane()`, defaulting to 0 for a caller
 * with no scheduler behind it. `replay.ts` is again the caller that
 * supplies one, re-feeding a recorded `Envelope.step` back in so a replayed
 * invocation's envelope matches the one the original invocation recorded
 * rather than silently reverting to 0 (docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md
 * §6: "`step` is a property of the program's shape and is identical on
 * replay").
 */
export async function invokeWithInput(
  nodeDef: NodeDef,
  input: unknown,
  context: InvocationContext,
): Promise<{ result: unknown; envelope?: Envelope }> {
  if (nodeDef.input.kind === "single") {
    return await (membrane as AnySingleInvoke)(nodeDef, input, context);
  }

  const bag = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return await (membrane as AnyAllOfInvoke)(nodeDef, bag, context);
}
