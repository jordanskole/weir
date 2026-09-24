/**
 * Re-runs a recorded invocation against the implementation it was pinned
 * to (docs/design.md §10; docs/superpowers/specs/2026-09-23-invocation-records-and-replay.md).
 *
 * It does not compare the replayed result to the recorded one. Deciding
 * what equality means for a `Failed<In>`, a `many` collection, or anything
 * carrying a timestamp is a real question, and answering it badly is how
 * this codebase has produced false greens before. Re-running honestly is
 * the primitive; judging the result is the caller's.
 *
 * The replayed call is re-fed `entry.envelope.identity` — the *narrowed*
 * identity the trace recorded, not the full claims set the original caller
 * actually held (`membrane.ts` never records that; only the fields a
 * node's `scope` declared are ever kept). That's why this is honestly
 * recoverable at all: re-narrowing an already-narrowed identity by the
 * same `scope` is idempotent, so a replayed node reads back exactly what
 * it read the first time. It stops being idempotent the moment `scope`
 * widens after the fact — a field the original invocation's `scope` didn't
 * declare was never recorded, so a replay against a widened declaration
 * cannot recover it.
 *
 * `entry.envelope.step` is re-fed the same way, and for a simpler reason:
 * it isn't narrowed or derived, it's recorded verbatim, so replaying it
 * means passing it straight back through (docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md
 * §6: "`step` is a property of the program's shape and is identical on
 * replay"). Without this, `invokeWithInput`'s default of 0 would silently
 * overwrite whatever pulse the invocation actually ran in.
 *
 * A widened `scope` is caught by the hash-drift refusal below, which is
 * where it belongs: `hash.ts`'s `fingerprintNode` covers `scope`, so the
 * declaration's hash no longer matches the recorded `contractHash` and the
 * replay refuses by name rather than quietly handing `Fn` an identity
 * missing the newly-declared field. Refusing is the honest outcome — there
 * is no fuller identity anywhere to recover that field from, so a replay
 * under the widened declaration could never be faithful.
 */

import { hashNode } from "./hash.js";
import { resolveImplementationAt } from "./implementation.js";
import { invokeWithInput } from "./invoke.js";
import type { TraceEntry } from "./trace.js";
import type { NodeDecl } from "./types.js";

export async function replayInvocation(
  entry: TraceEntry,
  node: NodeDecl,
  implRoot: string,
): Promise<unknown> {
  const current = (await hashNode(node)).hash;
  if (current !== entry.envelope.contractHash) {
    throw new Error(
      `Cannot replay "${entry.envelope.node}": the declaration supplied hashes to "${current}", ` +
        `but this invocation ran under "${entry.envelope.contractHash}". Replaying the pinned ` +
        `implementation against a changed contract would not be a replay of anything that happened ` +
        `— docs/design.md §5's "migrate through a declared rule or refuse", and there is no ` +
        `migration story for contracts.`,
    );
  }

  const nodeDef = await resolveImplementationAt(node, implRoot, entry.envelope.contractHash);
  const { result } = await invokeWithInput(
    nodeDef,
    entry.input,
    entry.envelope.correlationId,
    entry.envelope.identity,
    entry.envelope.step,
  );
  return result;
}
