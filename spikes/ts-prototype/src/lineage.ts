import type { Log, LoggedInstance } from "./membrane.js";

/**
 * Every transitive ancestor of an instance, oldest first, each appearing
 * once.
 *
 * The walk: an instance carries `envelope.id`, the invocation that
 * produced it, and that envelope carries `causationIds`, the instances
 * that invocation consumed. Recurse.
 *
 * This is a DAG walk, not a chain — a fan-in invocation has several
 * parents, and two branches of a diamond reconverge on a shared ancestor
 * that must appear once. Deduplication is by instance id.
 *
 * Termination does not rely on the graph being acyclic: an ancestor is
 * always strictly earlier by `seq`, so the walk cannot revisit, but the
 * visited set is kept regardless. The cost is a `Set`; the alternative if
 * that invariant is ever wrong is an infinite loop.
 *
 * Correct rather than optimized. "Do these instances share an ancestor" —
 * the question a lineage join asks — is answerable from this but not
 * efficiently; optimizing belongs with the consumer that needs it.
 */
export function ancestorsOf(log: Log, instanceId: string): LoggedInstance[] {
  const seen = new Set<string>();
  const found: LoggedInstance[] = [];
  const queue: string[] = [instanceId];

  while (queue.length > 0) {
    const current = log.instanceById(queue.shift()!);
    if (current === undefined) continue;
    for (const parentId of current.envelope?.causationIds ?? []) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = log.instanceById(parentId);
      if (parent === undefined) continue;
      found.push(parent);
      queue.push(parentId);
    }
  }

  return found.sort((a, b) => a.seq - b.seq);
}
