/**
 * Re-runs a recorded invocation against the implementation it was pinned
 * to (docs/design.md §10; docs/superpowers/specs/2026-09-23-invocation-records-and-replay.md).
 *
 * It does not compare the replayed result to the recorded one. Deciding
 * what equality means for a `Failed<In>`, a `many` collection, or anything
 * carrying a timestamp is a real question, and answering it badly is how
 * this codebase has produced false greens before. Re-running honestly is
 * the primitive; judging the result is the caller's.
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
  const { result } = await invokeWithInput(nodeDef, entry.input, entry.envelope.correlationId);
  return result;
}
