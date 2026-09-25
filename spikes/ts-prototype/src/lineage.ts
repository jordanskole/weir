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

/**
 * Which combinations of candidates should fire, one map per firing.
 *
 * **Grouping is by nearest common ancestor, not any common ancestor.** A
 * correlation has one origin event, so every token in a run descends from
 * the same origin instance — "shares an ancestor" is true of every
 * combination including every wrong one. What discriminates is which
 * ancestor is nearest, and `seq` delivers that directly: an ancestor is
 * always strictly earlier, so the nearest is the highest-`seq` member of
 * the intersection. Scanning ancestors in descending `seq` finds it
 * first, which is also what stops the origin forming a wrong group — by
 * the time the scan reaches it, nearer ancestors have claimed their
 * instances.
 *
 * **Within a group, candidates zip.** Sorted by `seq` and paired
 * positionally, one firing per complete row, ragged leftovers left
 * unconsumed until their partners arrive. Not newest-of-each, which drops
 * data, and not the cartesian product, which multiplies it.
 *
 * **When no candidate has an envelope, latest-wins.** An envelope records
 * that an invocation produced an instance; none means the values were
 * supplied from outside, which is the direct-invocation path — an agent
 * tool call, `fuzz`, `accept`. There is no lineage to join on because
 * nothing upstream ran, and exactly one candidate per edge, so
 * latest-wins has nothing to choose between.
 *
 * An envelope-less instance among instances that do have lineage is a
 * wildcard: it has no lineage to contradict, so it can fill any edge in
 * any group — the same reasoning that lets it bypass the arc rule.
 *
 * Correct rather than optimized: O(candidates × lineage size) per call,
 * re-walked every pulse. Lineages are immutable once written so they
 * cache trivially, and a real runtime would likely compute the branch key
 * at write time and make this a map lookup.
 */
export function joinRows(
  log: Log,
  candidates: Map<string, LoggedInstance[]>,
): Map<string, LoggedInstance>[] {
  const edgeNames = [...candidates.keys()];
  if (edgeNames.length === 0) return [];
  if (edgeNames.some((name) => (candidates.get(name) ?? []).length === 0)) return [];

  const every = edgeNames.flatMap((name) => candidates.get(name)!);
  if (every.every((instance) => instance.envelope === undefined)) {
    const row = new Map<string, LoggedInstance>();
    for (const name of edgeNames) {
      const list = candidates.get(name)!;
      row.set(name, list[list.length - 1]);
    }
    return [row];
  }

  // ancestor id -> edge name -> candidates descending from it
  const byAncestor = new Map<string, Map<string, LoggedInstance[]>>();
  for (const name of edgeNames) {
    for (const instance of candidates.get(name)!) {
      for (const ancestorId of selfAndAncestorIds(log, instance.id)) {
        let perEdge = byAncestor.get(ancestorId);
        if (perEdge === undefined) {
          perEdge = new Map();
          byAncestor.set(ancestorId, perEdge);
        }
        perEdge.set(name, [...(perEdge.get(name) ?? []), instance]);
      }
    }
  }

  const seqOf = (id: string): number => log.instanceById(id)?.seq ?? -1;
  const ordered = [...byAncestor.keys()].sort((a, b) => seqOf(b) - seqOf(a));

  const rows: Map<string, LoggedInstance>[] = [];
  const claimed = new Set<string>();

  for (const ancestorId of ordered) {
    const perEdge = byAncestor.get(ancestorId)!;
    const available = new Map<string, LoggedInstance[]>();
    let complete = true;

    for (const name of edgeNames) {
      const wildcards = candidates.get(name)!.filter((i) => i.envelope === undefined);
      const merged = [...new Map([...(perEdge.get(name) ?? []), ...wildcards].map((i) => [i.id, i])).values()]
        .filter((i) => !claimed.has(i.id))
        .sort((a, b) => a.seq - b.seq);
      if (merged.length === 0) {
        complete = false;
        break;
      }
      available.set(name, merged);
    }
    if (!complete) continue;

    const depth = Math.min(...edgeNames.map((name) => available.get(name)!.length));
    for (let i = 0; i < depth; i += 1) {
      const row = new Map<string, LoggedInstance>();
      for (const name of edgeNames) {
        const instance = available.get(name)![i];
        row.set(name, instance);
        claimed.add(instance.id);
      }
      rows.push(row);
    }
  }

  return rows;
}
