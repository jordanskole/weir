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
 * the intersection. Scanning ancestors in descending `seq` finds it first.
 *
 * **Descending `seq` alone does not stop the origin forming a wrong
 * group.** This comment used to claim it did — "by the time the scan
 * reaches it, nearer ancestors have claimed their instances" — which holds
 * only if those nearer groups *complete*. When two arms of a fan-in lead in
 * opposite directions (entity A stalled on one arm, entity B on the other)
 * neither group completes, nothing is claimed, and the scan reaches the run
 * origin, a genuine common ancestor of everything, and fires cross-entity
 * rows. Hence the `held` check below, which is the actual safeguard; see
 * its own comment and spec §2.
 *
 * **Within a group, candidates zip.** Sorted by `seq` and paired
 * positionally, one firing per complete row, ragged leftovers left
 * unconsumed until their partners arrive. Not newest-of-each, which drops
 * data, and not the cartesian product, which multiplies it.
 *
 * **When no candidate has an envelope, latest-wins.** An envelope records
 * that an invocation produced an instance; none means the values were
 * supplied from outside. There is no lineage to join on, so latest-wins
 * has nothing to choose between.
 *
 * This tier used to be described as the direct-invocation path — "an agent
 * tool call, `fuzz`, `accept`". It is not, and has not been since the
 * membrane stopped resolving `allOf` bags (spec §5): `invokeWithInput`
 * hands its bag straight to `membrane` and never reaches this function at
 * all. What is true is narrower — the tier handles candidates with no
 * lineage, and the only caller that produces them today is a host staging
 * envelope-less instances into a real `Log` and running `runNetlist` over
 * it, which in this spike means tests.
 *
 * An envelope-less instance among instances that do have lineage is a
 * wildcard: it has no lineage to contradict, so it can fill any edge in
 * any group — the same reasoning that lets it bypass the arc rule.
 *
 * Correct rather than optimized: O(candidates × lineage size) per call,
 * re-walked every pulse, and the `held` check multiplies that by the
 * ancestor-key count again, since it re-evaluates completeness against the
 * candidates still unclaimed at the moment it is asked — which is what
 * makes it temporal, and why it is not hoisted out of the scan. Lineages
 * are immutable once written so they cache trivially (this call memoizes
 * them for its own duration), and a real runtime would likely compute the
 * branch key at write time and make this a map lookup.
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

  /** The node that produced an instance, or `undefined` for a staged one. */
  const producerOf = (id: string): string | undefined => log.instanceById(id)?.envelope?.node;

  /**
   * Which *invocation* produced an instance — shared by every edge one
   * `allOf`-output firing emits, distinct between two firings of the same
   * node. `undefined` for a staged instance, which has no envelope.
   */
  const firingOf = (id: string): string | undefined => log.instanceById(id)?.envelope?.id;

  /**
   * May this candidate group at `ancestorId`, given that an *external*
   * ancestor is not a join point?
   *
   * An ancestor with no envelope was not produced by any invocation: it is
   * the run root, or an instance a host staged into the log. The run root
   * exists to make ancestry **total** — so a lineage walk terminates, and so
   * a composite node handed the whole log can rely on it — and that is a
   * different job from being somewhere to join. Left as an ordinary
   * ancestor it would be a common ancestor of *everything* in the run, which
   * is precisely the pairing free-for-all the `held` rule exists to prevent,
   * reintroduced one level up and immune to `held`'s peer clause (two
   * different origin *nodes* are not peers).
   *
   * The rule: at an external ancestor, only its **direct** children group.
   * Two instances that both descend from the root through intermediate
   * invocations share nothing but the fact that they happened in the same
   * run, which is not a reason to pair them. Two instances the root produced
   * directly — an origin's outputs, or several origins triggered by one
   * event — genuinely do belong to that one trigger, which is the case
   * `design.md` §5 blesses.
   *
   * An envelope-less *candidate* is unaffected: it is a wildcard with no
   * lineage to contradict, and that behaviour predates this rule.
   */
  const externalAncestorAllows = (instance: LoggedInstance, ancestorId: string): boolean => {
    if (log.instanceById(ancestorId)?.envelope !== undefined) return true;
    if (instance.envelope === undefined) return true;
    if (instance.id === ancestorId) return true;
    return instance.envelope.causationIds.includes(ancestorId);
  };

  const lineages = new Map<string, Set<string>>();
  const lineageOf = (instanceId: string): Set<string> => {
    let found = lineages.get(instanceId);
    if (found === undefined) {
      found = selfAndAncestorIds(log, instanceId);
      lineages.set(instanceId, found);
    }
    return found;
  };

  const unclaimedAt = (ancestorId: string): Map<string, LoggedInstance[]> => {
    const perEdge = byAncestor.get(ancestorId);
    const out = new Map<string, LoggedInstance[]>();
    for (const name of edgeNames) {
      const wildcards = candidates.get(name)!.filter((i) => i.envelope === undefined);
      out.set(
        name,
        [...new Map([...(perEdge?.get(name) ?? []), ...wildcards].map((i) => [i.id, i])).values()]
          .filter((i) => !claimed.has(i.id))
          .sort((a, b) => a.seq - b.seq),
      );
    }
    return out;
  };

  const isIncomplete = (at: Map<string, LoggedInstance[]>): boolean => {
    const filled = edgeNames.filter((name) => at.get(name)!.length > 0).length;
    return filled > 0 && filled < edgeNames.length;
  };

  /**
   * May this candidate join at `ancestorId`, or is a nearer group of its own
   * still forming?
   *
   * The rule: a candidate may not join at `A` if it has a **strictly nearer**
   * ancestor `B` that is currently **incomplete** — `B` has unclaimed
   * candidates on some of the node's declared edges but not all — **and** a
   * **peer** of `B` holds one of the edges `B` is missing. A peer is another
   * instance of the *same producing node*, off this candidate's own lineage:
   * two items at the same stage of the graph, one carrying each half of a
   * fan-in. When that is the picture, falling through to a common ancestor of
   * both would pair the two items with each other, which is exactly the
   * cross-lineage row the join exists to prevent.
   *
   * The peer clause is load-bearing, not decoration. Without it every
   * candidate is held forever: a `Left` candidate's own id is an ancestor key
   * holding a `Left` and no `Right`, so *every* candidate always has a nearer
   * incomplete ancestor — itself — and nothing ever fires (verified: 13 of
   * this spike's tests, including the plain diamond, fail that way). Every
   * intermediate hop on one arm is "incomplete" in the same vacuous sense.
   * What distinguishes `E_A` (an entity whose other arm is still in flight)
   * from `hop3_A` (a step on the arm that already arrived) is not visible in
   * lineage alone — both hold a Left and no Right. It becomes visible when a
   * *sibling instance of the same node* holds the missing edge: that is the
   * signature of two items mid-flight in opposite directions, and it is the
   * only such signature a `Log` of ancestors can see. A richer runtime that
   * could ask "is work still in flight below `B`" — an index of unconsumed
   * descendants, or the program's wiring — would not need the peer clause;
   * `joinRows` has neither, by design (it takes a `Log` and candidates).
   *
   * The cost of the approximation is stated rather than hidden: two arms that
   * diverge at *different* nodes rather than at two instances of one node are
   * not held, and would still mispair. No topology in the spike does that,
   * and the general case wants the in-flight test, not a better lineage
   * heuristic.
   */
  const held = (instance: LoggedInstance, ancestorId: string): boolean => {
    // Property: an envelope-less candidate has no ancestors, so "has a nearer
    // incomplete ancestor" is vacuously false. The latest-wins tier and the
    // wildcard behaviour are untouched by this check.
    if (instance.envelope === undefined) return false;
    const own = lineageOf(instance.id);

    for (const nearerId of own) {
      if (seqOf(nearerId) <= seqOf(ancestorId)) continue;
      const at = unclaimedAt(nearerId);
      if (!isIncomplete(at)) continue;
      const node = producerOf(nearerId);
      if (node === undefined) continue;
      const missing = edgeNames.filter((name) => at.get(name)!.length === 0);

      for (const peerId of byAncestor.keys()) {
        if (peerId === nearerId || own.has(peerId)) continue;
        if (producerOf(peerId) !== node) continue;
        // Same node is not enough: a peer must be a different *firing*. An
        // `allOf`-output node emits several edges from one invocation, and
        // every instance of that emission carries the same envelope `id`
        // (`runtime.ts`'s `instanceEnvelope` spreads the invocation envelope
        // onto each). Those are two halves of one emission, not two items
        // mid-flight in opposite directions — treating them as peers holds
        // each out on account of the other and the group never forms. Found
        // by execution once the run root made their shared ancestry
        // reachable: before it, they had no common ancestor to be held out
        // of, so the bug was unreachable rather than absent.
        if (firingOf(peerId) !== undefined && firingOf(peerId) === firingOf(nearerId)) continue;
        const atPeer = unclaimedAt(peerId);
        if (missing.some((name) => atPeer.get(name)!.length > 0)) return true;
      }
    }
    return false;
  };

  for (const ancestorId of ordered) {
    const available = new Map<string, LoggedInstance[]>();
    let complete = true;

    for (const name of edgeNames) {
      const merged = unclaimedAt(ancestorId)
        .get(name)!
        .filter((i) => externalAncestorAllows(i, ancestorId) && !held(i, ancestorId));
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
