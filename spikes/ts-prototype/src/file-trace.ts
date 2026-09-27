/**
 * A `Trace` that outlives the process — the second half of the durable
 * pair (docs/superpowers/specs/2026-09-26-replay-and-the-determinism-check.md
 * §1). `FileLog` records what nodes *emitted*; this records what they were
 * *invoked with* and what came back, which is what replay needs and what
 * the determinism check compares against.
 *
 * Same shape as `FileLog` and for the same reasons: an append-only `.jsonl`
 * file with an in-memory index, reads synchronous and answered from the
 * index. Making `Trace` async would buy nothing a spike needs and would
 * spread awaits through `runtime.ts`'s firing path.
 *
 * One difference from the Log: a `TraceEntry` has no `seq` and no id of its
 * own. Its identity is `envelope.id`, the invocation — which is enough to
 * index by, and enough to address one entry from the CLI.
 *
 * Known limits, named rather than assumed away: one writer, no fsync (a
 * crash can lose the tail), no compaction.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Trace, TraceEntry } from "./trace.js";

export class FileTrace implements Trace {
  readonly #path: string;
  readonly #byCorrelation = new Map<string, TraceEntry[]>();

  private constructor(path: string) {
    this.#path = path;
  }

  /** Opens `path`, rebuilding the index from whatever is there. A path that does not exist yet is an empty trace, not an error. */
  static open(path: string): FileTrace {
    const trace = new FileTrace(path);
    if (!existsSync(path)) return trace;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      trace.#index(JSON.parse(line) as TraceEntry);
    }
    return trace;
  }

  #index(entry: TraceEntry): void {
    const key = entry.envelope.correlationId;
    const existing = this.#byCorrelation.get(key);
    if (existing === undefined) this.#byCorrelation.set(key, [entry]);
    else existing.push(entry);
  }

  record(entry: TraceEntry): void {
    this.#index(entry);
    appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** A copy, in record order: callers iterate this while a run appends to the same trace. */
  entries(correlationId: string): TraceEntry[] {
    return [...(this.#byCorrelation.get(correlationId) ?? [])];
  }
}
