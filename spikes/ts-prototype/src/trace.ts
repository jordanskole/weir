/**
 * A run's record — one entry per invocation (docs/design.md §10: "an
 * invocation records which implementation version it actually ran under,
 * immutable once written"). Distinct from the edge Log, which stores what
 * nodes *emitted*: one invocation can emit several instances, so the two
 * live at different grains and neither is derivable from the other.
 *
 * `netlist.ts` already reserves this word — it "deliberately excludes
 * `trace` (a run's log, not elaboration's output)".
 */

import type { Envelope } from "./types.js";

export interface TraceEntry {
  /** Carries `node` + `contractHash`: the version pin this invocation ran under. */
  envelope: Envelope;
  input: unknown;
  result: unknown;
}

export interface Trace {
  record(entry: TraceEntry): void;
  entries(correlationId: string): TraceEntry[];
}

/** In-memory Trace — the spike has no store; enough to replay against. */
export class InMemoryTrace implements Trace {
  private readonly recorded: TraceEntry[] = [];
  record(entry: TraceEntry): void {
    this.recorded.push(entry);
  }
  entries(correlationId: string): TraceEntry[] {
    return this.recorded.filter((entry) => entry.envelope.correlationId === correlationId);
  }
}
