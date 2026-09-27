/**
 * The determinism check
 * (docs/superpowers/specs/2026-09-26-replay-and-the-determinism-check.md §3).
 *
 * `design.md` §0 states Principle 0 — decomposition is bounded by
 * determinism — and says weir makes it mechanical. This is the mechanism:
 * replay each recorded invocation against its pinned implementation and
 * compare what comes back to what was recorded. A mismatch is evidence the
 * node read something its contract does not declare.
 *
 * **Why the comparison isolates the violation rather than merely
 * correlating with "touches the world".** A fixed-weight classifier replays
 * identically and passes — uncertainty in an output is not nondeterminism in
 * a function. Nondeterminism that was declared as an *effect* also passes,
 * because the runtime performed it and recorded the answer, so the replay is
 * handed the same input and returns the same output. Only nondeterminism a
 * node reached for directly — a clock, an unseeded sample — differs.
 *
 * **What it cannot see**, stated here so a clean result is not mistaken for
 * a proof: nondeterminism that happens to agree twice. A node reading a
 * clock at second granularity passes when the replay lands in the same
 * second. This finds violations; it does not certify their absence, which is
 * the ordinary asymmetry of a test and is reported as such.
 */

import { replayInvocation } from "./replay.js";
import type { TraceEntry } from "./trace.js";
import type { NodeDecl } from "./types.js";

export interface Mismatch {
  node: string;
  invocationId: string;
  input: unknown;
  recorded: unknown;
  replayed: unknown;
}

export interface VerifyReport {
  checked: number;
  /** Entries whose node is not in the program — reported rather than counted as passing. */
  skipped: { node: string; invocationId: string; reason: string }[];
  /**
   * Effect nodes, which are neither checked nor skipped: they are where
   * nondeterminism enters a program *by declaration*, so their determinism
   * was never claimed and is not in question.
   *
   * A third category rather than a pass, because replay feeds an effect's
   * recorded result straight back — so comparing it to the record is
   * vacuous by construction, and counting it as a passing check would build
   * this repo's most frequent bug into the feature itself.
   */
  declaredNondeterministic: { node: string; effect: string; invocationId: string }[];
  mismatches: Mismatch[];
}

/**
 * Structural equality on payloads. Not identity, and not `JSON.stringify`
 * comparison: key order is an artifact of construction, and a `many`
 * collection is keyed rather than positional (design-history.md, "`many` is
 * a collection, keyed by index, not an array"), so two results that differ
 * only in the order their keys were written are the same result. Arrays
 * stay order-significant, because an array inside a payload is ordinary
 * data rather than a collection of edge instances.
 */
export function sameResult(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameResult(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && sameResult(left[key], right[key]));
}

/**
 * Replays every entry and reports the ones that came back different.
 *
 * `nodes` is keyed as the program keys it, which for an inlined composite is
 * the *position* (`investigate/investigateIdentity`) while `envelope.node`
 * records that same position — see `InvocationContext.nodeName`. An entry
 * whose node is not in the program is skipped and said so, never silently
 * counted as passing: a check that quietly examines nothing is the failure
 * mode this repo keeps finding.
 */
export async function verifyRun(
  entries: TraceEntry[],
  nodes: Record<string, NodeDecl>,
  implRoot: string,
): Promise<VerifyReport> {
  const report: VerifyReport = { checked: 0, skipped: [], declaredNondeterministic: [], mismatches: [] };

  for (const entry of entries) {
    const node = nodes[entry.envelope.node];
    if (node === undefined) {
      report.skipped.push({
        node: entry.envelope.node,
        invocationId: entry.envelope.id,
        reason: "not declared in this program",
      });
      continue;
    }

    if (node.effect !== undefined) {
      report.declaredNondeterministic.push({
        node: entry.envelope.node,
        effect: node.effect,
        invocationId: entry.envelope.id,
      });
      continue;
    }

    let replayed: unknown;
    try {
      replayed = await replayInvocation(entry, node, implRoot);
    } catch (error) {
      // A declaration that has drifted, or an implementation that is gone.
      // Neither is a determinism verdict, so it is not reported as one.
      report.skipped.push({
        node: entry.envelope.node,
        invocationId: entry.envelope.id,
        reason: (error as Error).message,
      });
      continue;
    }

    report.checked += 1;
    if (!sameResult(entry.result, replayed)) {
      report.mismatches.push({
        node: entry.envelope.node,
        invocationId: entry.envelope.id,
        input: entry.input,
        recorded: entry.result,
        replayed,
      });
    }
  }

  return report;
}
