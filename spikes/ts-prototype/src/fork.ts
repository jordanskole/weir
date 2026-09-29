/**
 * Forking a recorded run
 * (docs/superpowers/specs/2026-09-29-drift-and-fork.md §4-§6).
 *
 * A fork re-executes a recorded run under the **current** declarations, into a
 * new `correlationId`. It exists because widening an edge in response to drift
 * raises the obvious question of what happens to the run that recorded the old
 * shape, and the answer is **nothing**: the log is append-only and the recorded
 * run is the historical record of what actually crossed the wire.
 *
 * Re-validated data therefore lands in a new run, and the reason is mechanical
 * rather than philosophical. A run is the unit of consumption, so appending a
 * second instance to the same `correlationId` would put two instances of one
 * logical token on the same wire, where every downstream node sees both as
 * unconsumed candidates and fires twice.
 *
 * **The execution rule is a hybrid, and it is the heart of this.** Effect nodes
 * return the parent's recorded result; pure nodes genuinely re-execute. Two
 * properties fall out, and both are what make an agent loop over candidate
 * schemas viable:
 *
 * - **A fork is deterministic.** Every nondeterministic input is pinned to the
 *   parent's recording, so forking one run against a hundred candidate schemas
 *   varies only the declarations.
 * - **A fork needs no effect handlers, and no credentials.** Every effect comes
 *   from the trace, so a production run can be forked on a laptop with no
 *   access to the systems it touched.
 */

import { isDeepStrictEqual } from "node:util";
import { hashNode } from "./hash.js";
import { resolveImplementationAt } from "./implementation.js";
import type { Elaborated } from "./elaborate.js";
import type { NodeDecl, NodeDef } from "./types.js";
import type { TraceEntry } from "./trace.js";

/** A node the fork cannot run, and why. */
export interface BlockedNode {
  node: string;
  /** The contract hash it needs an implementation for — the one after the edit. */
  contractHash: string;
  reason: string;
}

export interface ForkPlan {
  /** Handlers that answer from the parent's recording rather than the world. */
  effects: Record<string, (payload: unknown) => unknown>;
  /** Nodes with no accepted implementation under their current contract. */
  blocked: BlockedNode[];
  /**
   * The first node whose contract hash differs from the parent's recording —
   * where this fork diverges. Derived, never declared: everything before it
   * reproduces identically, and everything from it forward is the interesting
   * part.
   */
  divergesAt: string | undefined;
  /** How many recorded effect results are available to answer from. */
  recordedEffects: number;
}

/**
 * Builds what a fork needs from a parent run's trace and the current program.
 *
 * Separated from running it so `weir fork` can report a blocked fork *before*
 * writing anything, and so the plan is testable without a runtime.
 */
export async function planFork(
  program: Elaborated,
  entries: TraceEntry[],
  implRoot: string,
): Promise<ForkPlan> {
  const effectNodes = new Map<string, NodeDecl>();
  for (const [name, node] of Object.entries(program.nodes)) {
    if (node.effect !== undefined) effectNodes.set(name, node);
  }

  /**
   * Recorded effect results, keyed by nothing — matched by **input**.
   *
   * Deliberately not matched by position or by causation id. A fork mints new
   * instance ids, so recorded `causationIds` cannot match; and firing *order*
   * may legitimately diverge from the parent's the moment a widened edge
   * changes what a downstream node produces, which is the whole point of
   * forking. Matching on the request itself is the one key that survives both:
   * *what did the world answer when we asked exactly this?*
   *
   * The cost, stated rather than discovered: if a fork asks something the
   * parent never asked, there is no recorded answer and the effect fails
   * rather than reaching the network. That is correct — a fork that could
   * silently make a live call would not be reproducible, and would need the
   * credentials this exists to avoid.
   */
  const recorded = entries.filter((entry) => effectNodes.has(entry.envelope.node));

  const effects: Record<string, (payload: unknown) => unknown> = {};
  for (const node of effectNodes.values()) {
    effects[node.effect!] ??= (payload: unknown) => {
      const match = recorded.find((entry) => isDeepStrictEqual(entry.input, payload));
      if (match === undefined) {
        throw new Error(
          `fork: no recorded result for this request, so there is nothing to replay. ` +
            `A fork answers every effect from the parent run's trace and never calls out, ` +
            `so a request the parent never made cannot be answered. Input: ${JSON.stringify(payload)}`,
        );
      }
      return match.result;
    };
  }

  // Which nodes can actually run under the declarations as they are now.
  const blocked: BlockedNode[] = [];
  let divergesAt: string | undefined;
  const recordedHashes = new Map(entries.map((e) => [e.envelope.node, e.envelope.contractHash]));

  for (const [name, node] of Object.entries(program.nodes)) {
    const { hash } = await hashNode(node);
    const was = recordedHashes.get(name);
    if (was !== undefined && was !== hash && divergesAt === undefined) divergesAt = name;
    if (node.effect !== undefined) continue; // performed from the recording
    try {
      await resolveImplementationAt(node as NodeDecl, implRoot, hash);
    } catch (cause) {
      blocked.push({ node: name, contractHash: hash.slice(0, 8), reason: (cause as Error).message });
    }
  }

  return { effects, blocked, divergesAt, recordedEffects: recorded.length };
}

/**
 * The program a fork runs: current declarations, with every resolvable
 * implementation bound. An effect node keeps its throwing stub, because the
 * runtime performs it through `effects` instead.
 */
export async function bindResolvable(
  program: Elaborated,
  implRoot: string,
): Promise<Record<string, NodeDef>> {
  const bound: Record<string, NodeDef> = {};
  for (const [name, node] of Object.entries(program.nodes)) {
    const { hash } = await hashNode(node);
    try {
      bound[name] = await resolveImplementationAt(node as NodeDecl, implRoot, hash);
    } catch {
      // Left out deliberately: `planFork` already reported it as blocked, and a
      // half-bound program is what the caller refuses to run.
    }
  }
  return bound;
}
