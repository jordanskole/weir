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

/**
 * Every id in an instance's lineage, itself included.
 *
 * `ancestorsOf` returns instances and excludes the starting one, which is
 * right for "where did this come from" and wrong for a join: two
 * instances join on the highest-`seq` member of the intersection of their
 * lineages, and an `allOf` node consuming an edge straight from the
 * origin would never join at all under a pure-ancestors reading — the
 * origin instance has no ancestors, so the intersection is empty. Self
 * has to count. That is not a patch: if one instance is an ancestor of
 * the other they plainly belong together.
 *
 * Ids rather than instances because the join only compares and orders
 * them, and a `Set<string>` intersects directly.
 *
 * An instance with no envelope was supplied from outside rather than
 * produced by an invocation, so its lineage is just itself.
 */
export function selfAndAncestorIds(log: Log, instanceId: string): Set<string> {
  const seen = new Set<string>([instanceId]);
  const queue: string[] = [instanceId];

  while (queue.length > 0) {
    const current = log.instanceById(queue.shift()!);
    if (current === undefined) continue;
    for (const parentId of current.envelope?.causationIds ?? []) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      queue.push(parentId);
    }
  }

  return seen;
}
