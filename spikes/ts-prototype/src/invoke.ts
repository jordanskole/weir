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
import { Identity } from "./types.js";
import type { Envelope, NodeDef, PayloadOf } from "./types.js";

/**
 * The same documented cast idiom `runtime.ts` already uses: `membrane()`'s
 * return type is a conditional on NodeDef's generic `In`, which TS can't
 * resolve from a plain, doubly-defaulted `NodeDef` even after
 * `nodeDef.input.kind` has been checked at the value level — a real TS
 * narrowing limitation, not a genuine call-shape ambiguity (the `kind`
 * branch checks it at runtime). Both call shapes carry the same third and
 * fourth, optional `identity`/`step` arguments `membrane.ts`'s real
 * `SingleInvoke`/`AllOfInvoke` accept — `identity` typed `Partial`,
 * matching `Envelope.identity` itself, because replay's caller (see
 * `replayInvocation`) can only ever supply a previously *narrowed*
 * identity, never the full claims set.
 */
type AnySingleInvoke = (
  payload: unknown,
  correlationId: string,
  identity?: Partial<PayloadOf<typeof Identity>>,
  step?: number,
) => Promise<{ result: unknown; envelope?: Envelope }>;
type AnyAllOfInvoke = (
  correlationId: string,
  log: Log,
  identity?: Partial<PayloadOf<typeof Identity>>,
  step?: number,
) => Promise<{ result: unknown; envelope?: Envelope } | undefined>;

/**
 * Runs `nodeDef` once against one input case. A `single`-input node takes
 * its payload directly; an `allOf`-input node resolves readiness against a
 * Log instead, so the case's bag (keyed by edge name — `InputPayload`'s own
 * allOf shape) is appended to a fresh `InMemoryLog` under `correlationId`
 * first. One log per invocation, never shared, so nothing leaks between
 * cases. Resolves to `{ result: undefined }` for an `allOf` node whose bag
 * is missing a declared edge — `membrane()`'s own readiness `undefined` is
 * a bare not-ready signal there, but this function always resolves to the
 * `{ result, envelope? }` shape, so that signal is folded into `result`
 * rather than handed through as a bare `undefined` itself. A non-object
 * `input` (`null`, `undefined`, or any other non-object — what an
 * author-written example whose `given` is malformed, e.g. `given:` with
 * nothing after it in YAML, parses to) is treated the same way: every
 * declared edge simply reads as missing from it, landing on the same
 * not-ready `{ result: undefined }` rather than throwing a raw `TypeError`
 * trying to index into it. This module has two callers with two different
 * trust levels for `input` — `fuzz.ts`'s is always pre-validated generator
 * output, `accept.ts`'s is arbitrary author-written example data — and only
 * the latter can ever hand this a non-object, so the guard costs the former
 * nothing.
 *
 * `identity` is optional and passed straight through to `membrane()` —
 * omitted, a node resolves under `SYSTEM_IDENTITY` exactly as before
 * (membrane.ts's documented default). `replay.ts` is the caller that
 * supplies one, re-feeding a recorded `Envelope.identity` back in so a
 * scoped node's replayed result reflects who actually invoked it rather
 * than always falling through to the system default.
 *
 * `step` is threaded the same way, for the same reason: optional, trailing,
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
  correlationId: string,
  identity?: Partial<PayloadOf<typeof Identity>>,
  step?: number,
): Promise<{ result: unknown; envelope?: Envelope }> {
  if (nodeDef.input.kind === "single") {
    return await (membrane(nodeDef) as AnySingleInvoke)(input, correlationId, identity, step);
  }

  const log = new InMemoryLog();
  const bag = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  for (const edge of nodeDef.input.edges) {
    log.append(edge.name, correlationId, bag[edge.name]);
  }
  const invocation = await (membrane(nodeDef) as AnyAllOfInvoke)(correlationId, log, identity, step);
  return invocation ?? { result: undefined };
}
