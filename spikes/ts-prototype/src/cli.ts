/**
 * The command-line surface, kept deliberately small: the three things that
 * need nothing weir has not built.
 *
 * `check`, `graph` and `contract` are pure functions of a directory of
 * declarations — no log, no implementations, no runtime. `run` needs all
 * three, and could only ship once `FileLog` gave it a log that outlives the
 * process; before that it would have been a demo dressed as a tool.
 *
 * `replay` is still absent, and for a smaller reason than `run` was:
 * `replayInvocation` reads a *Trace* entry, and only the Log is durable so
 * far. The help text says so rather than leaving someone to find out.
 *
 * The core is `runCli(argv, cwd)`, returning a code and the text to print,
 * rather than a function that writes to stdout and calls `process.exit`.
 * That is the difference between a CLI whose behaviour is unit-testable and
 * one whose behaviour is only observable by shelling out — and this CLI's
 * whole point is its *errors*, which are exactly the thing worth asserting
 * on.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { elaborate } from "./elaborate.js";
import { serializeNetlist } from "./netlist.js";
import { exportContract } from "./contract.js";
import { emitZodModule } from "./emit-zod.js";
import { acceptImplementation } from "./accept.js";
import { runExamples } from "./test-run.js";
import { analyze, mediation } from "./sys.js";
import { plan } from "./plan.js";
import { crossings, zoneOf } from "./zones.js";
import { elaborateWithImplementations, resolveImplementation } from "./implementation.js";
import { resolveTrigger, runNetlist } from "./runtime.js";
import { FileLog } from "./file-log.js";
import { FileTrace } from "./file-trace.js";
import { replayInvocation } from "./replay.js";
import { verifyRun } from "./verify.js";
import { bindResolvable, planFork } from "./fork.js";

export interface CliResult {
  code: number;
  out: string;
}

const USAGE = `weir — a declarative framework of pure nodes wired by data schemas

usage
  weir check [dir]              elaborate the declarations and report what fails
  weir graph [dir] [--json]     print the topology, or the netlist as JSON
  weir contract <node> [dir]    print one node's sealed contract, as an agent receives it
  weir emit-zod <node> [dir]    print the node's edges as a zod module, the typed
                                form of the same contract
  weir run [dir] --impl <dir> --payload <file.json> [--effects <file.ts>]
                 [--log <file>] [--run <id>]
                                elaborate, resolve implementations, and execute
  weir fork [dir] --impl <dir> --from <run-id> [--trace <file>] [--log <file>]
                 [--run <new-id>]
                                re-execute a recorded run under the CURRENT
                                declarations, into a new run. Effects are
                                answered from the parent's trace, so no
                                --effects and no credentials are needed.
  weir replay [dir] --impl <dir> --run <id> [--trace <file>]
                                re-run each recorded invocation against its pinned implementation
  weir verify [dir] --impl <dir> --run <id> [--trace <file>]
                                replay and compare — a mismatch means undeclared nondeterminism
  weir accept <node> [dir] --source <file> --impl <dir>
                                run one candidate implementation through the acceptance gate
  weir test [dir] --impl <dir>  run every declared example — a node's through the
                                membrane, a topology's through a run
  weir plan <from> <to> [dir] [--json]
                                type-directed search: candidate routes from one edge
                                to another, each a runnable wiring, ordered by depth
  weir sys [dir] [--node <name>] [--json]
                                query the ontology and topology: what exists, what
                                refines what, what is orphaned or dropped; with
                                --node, what it mediates and what bypasses it

  dir defaults to the current directory.
  --payload is the trigger: one external event, shaped by the entry topology's
  declared input. A bare payload for a single input; a bag keyed by edge name
  for an allOf one. Every origin declaring that edge is populated from it.
  --effects supplies the host's handlers: a module default-exporting an object
  keyed by the name each .node's "effect:" field gives. Required when the
  program declares any effect, because an effect is performed by the host and
  never by a drafted implementation — which is what keeps every other node
  pure (design.md §0).

  --log defaults to ./weir.jsonl and is appended to, never truncated.

  --trace defaults to ./weir-trace.jsonl, written by run and read by the
  other two. Principle 0 (design.md §0) says decomposition is bounded by
  determinism; verify is what checks it.`;

/** Renders an elaboration failure without a stack trace — the message is the product. */
function failure(error: unknown, dir: string): CliResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 1,
    out: [
      `✗ ${dir}`,
      "",
      `  ${message}`,
    ].join("\n"),
  };
}

async function check(dir: string): Promise<CliResult> {
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }

  const { fields, edges, nodes, wiring } = elaborated;
  // Synthesized edges and nodes are counted separately from authored ones:
  // a count that silently includes every `Failed_X` reads as though the
  // author wrote twice what they wrote.
  const authoredEdges = Object.keys(edges).filter((n) => !n.startsWith("Failed_"));
  const authoredNodes = Object.keys(nodes).filter((n) => !n.startsWith("noop_") && !n.includes("/"));
  const inlined = Object.keys(nodes).filter((n) => n.includes("/"));

  return {
    code: 0,
    out: [
      `✓ ${dir}`,
      "",
      `  ${authoredEdges.length} edge(s), ${Object.keys(fields).length} field(s), ${authoredNodes.length} node(s)`,
      `  ${wiring.origins.length} origin(s): ${wiring.origins.join(", ")}`,
      ...(inlined.length > 0 ? [`  ${inlined.length} node(s) inlined from composites`] : []),
    ].join("\n"),
  };
}

/** One line per arc, sorted — a wiring is a set of arcs, and printing it as a tree would re-tell the lie that it is one. */
async function graph(dir: string, json: boolean): Promise<CliResult> {
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }

  if (json) {
    return { code: 0, out: JSON.stringify(await serializeNetlist(elaborated), null, 2) };
  }

  const { nodes, wiring } = elaborated;
  const arcs = Object.entries(wiring.feeds)
    .flatMap(([parent, children]) => children.map((child) => [parent, child] as const))
    .sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));

  const edgesOf = (name: string): string => {
    const node = nodes[name];
    if (node === undefined) return "?";
    const output = node.output;
    return output.kind === "single"
      ? output.edge.name
      : output.kind === "many"
        ? `many ${output.edge.name}`
        : output.edges.map((e) => e.name).join(` ${output.kind === "oneOf" ? "|" : "&"} `);
  };

  return {
    code: 0,
    out: [
      ...wiring.origins.map((o) => `  origin  ${o}`),
      ...arcs.map(([parent, child]) => `  ${parent} -> ${child}    ${edgesOf(parent)}`),
    ].join("\n"),
  };
}

async function run(dir: string, flags: Map<string, string>): Promise<CliResult> {
  const implRoot = flags.get("impl");
  const payloadPath = flags.get("payload");
  if (implRoot === undefined || payloadPath === undefined) {
    return { code: 1, out: `✗ run needs --impl and --payload.\n\n${USAGE}` };
  }

  let program;
  try {
    program = await elaborateWithImplementations(dir, resolve(implRoot));
  } catch (error) {
    return failure(error, dir);
  }

  let originPayloads: Record<string, unknown>;
  try {
    originPayloads = JSON.parse(await readFile(resolve(payloadPath), "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { code: 1, out: `✗ could not read --payload ${payloadPath}\n\n  ${(error as Error).message}` };
  }

  // The trigger is one external event, resolved to per-origin payloads through
  // the entry topology's declared `input` — `design.md` §5's "one call to the
  // graph's outer membrane per external event", with the CLI as that membrane
  // (2026-09-28-a-topology-declares-its-beginning.md §3). A program with no
  // entry contract still takes the per-node map directly.
  let resolvedPayloads: Record<string, unknown>;
  if ((program.entries ?? []).length > 0) {
    try {
      resolvedPayloads = resolveTrigger(program, originPayloads);
    } catch (error) {
      return { code: 1, out: `✗ ${(error as Error).message}` };
    }
  } else {
    resolvedPayloads = originPayloads;
  }

  // Worth naming rather than letting the run quietly do nothing: an origin
  // with no payload is never offered as a candidate, so the symptom would be
  // a graph reaching quiescence having fired nothing, with no error at all.
  const missing = program.wiring.origins.filter((o) => !(o in resolvedPayloads));
  if (missing.length > 0) {
    return {
      code: 1,
      out: `✗ the trigger supplies nothing for origin(s) ${missing.map((m) => `"${m}"`).join(", ")}.\n\n  --payload is shaped by the entry topology's declared input; these origins are ${program.wiring.origins.join(", ")}`,
    };
  }

  // **The host performs the effects, and the CLI is the host.** Without this,
  // `weir run` could not execute any program with an `effect:` node at all —
  // `runNetlist` refuses to start when a declared effect has no handler, and
  // nothing here ever passed one. Found by pointing the CLI at the first real
  // program anyone modelled, every fetch in which is an effect.
  let effects: Record<string, (payload: unknown) => Promise<unknown> | unknown> = {};
  const effectsPath = flags.get("effects");
  if (effectsPath !== undefined) {
    try {
      const mod = (await import(pathToFileURL(resolve(effectsPath)).href)) as { default?: unknown };
      const supplied = mod.default;
      if (supplied === null || typeof supplied !== "object") {
        return {
          code: 1,
          out: `✗ --effects ${effectsPath} must default-export an object keyed by effect name, got ${supplied === null ? "null" : typeof supplied}.`,
        };
      }
      // Checked here rather than left to fail mid-pulse: a non-function value
      // would otherwise surface as a type error deep inside a firing, with the
      // run already part-written to the log.
      const notFunctions = Object.entries(supplied).filter(([, v]) => typeof v !== "function");
      if (notFunctions.length > 0) {
        return {
          code: 1,
          out: `✗ --effects ${effectsPath} exports non-function handler(s): ${notFunctions.map(([k]) => k).join(", ")}.`,
        };
      }
      effects = supplied as typeof effects;
    } catch (error) {
      return { code: 1, out: `✗ could not load --effects ${effectsPath}\n\n  ${(error as Error).message}` };
    }
  }

  // Named before the run starts, so the message says what to supply rather than
  // reporting a half-written run. `runNetlist` enforces the same rule; this is
  // the CLI turning it into an instruction.
  const declared = [
    ...new Set(Object.values(program.nodes).flatMap((n) => (n.effect === undefined ? [] : [n.effect]))),
  ];
  const unhandled = declared.filter((name) => typeof effects[name] !== "function");
  if (unhandled.length > 0) {
    return {
      code: 1,
      out: [
        `✗ no handler for effect(s) ${unhandled.map((e) => `"${e}"`).join(", ")}.`,
        "",
        `  An effect is performed by the host, never by a drafted implementation`,
        `  — that is what keeps every other node pure (design.md §0). Supply them`,
        `  with --effects <file.ts>, default-exporting an object keyed by the name`,
        `  each .node's \`effect:\` field gives:`,
        "",
        `      export default { ${unhandled[0]}: async (payload) => { /* ... */ } }`,
      ].join("\n"),
    };
  }

  const logPath = resolve(flags.get("log") ?? "weir.jsonl");
  const tracePath = resolve(flags.get("trace") ?? "weir-trace.jsonl");
  const log = FileLog.open(logPath);
  const trace = FileTrace.open(tracePath);
  const correlationId = flags.get("run") ?? crypto.randomUUID();
  const result = await runNetlist(
    program,
    { correlationId, originPayloads: resolvedPayloads },
    { log, trace, effects },
  );

  const detail = [
    "",
    `  run       ${correlationId}`,
    `  firings   ${result.firings}`,
    `  pulses    ${result.pulses}`,
    `  log       ${logPath}`,
    `  trace     ${tracePath}`,
  ];

  // Residue at quiescence is a **stall**: nothing fired, and something is
  // waiting that nothing will ever deliver
  // (docs/superpowers/specs/2026-09-27-quiescence-is-not-success.md). A CLI run
  // is someone asking "did this work", so it is an error here even though the
  // runtime only reports it — the runtime leaves the verdict to the host
  // because bounding a run is the host's job, and this is that host deciding.
  //
  // Residue after `budget` is *not* an error: a bounded run has unconsumed
  // input by construction. It is still printed, because it is the most useful
  // thing to see when deciding whether the budget was too small.
  // An unmet end and a stall are independent questions with independent
  // answers (2026-09-28-a-root-topology-declares-its-end.md): a run can reach
  // its declared end while stranding a side branch, or consume everything and
  // never get there. Both are reported; neither message replaces the other.
  const unmetLines = result.unmet.flatMap((u) => [
    `  missing   ${u.missing.join(", ")} — declared by ${u.topology}, from ${u.terminals.join(", ")}`,
  ]);

  if (result.unmet.length > 0) {
    return {
      code: 1,
      out: [
        `✗ did not reach its declared end`,
        ...detail,
        "",
        ...unmetLines,
        ...(result.residue.length > 0
          ? ["", ...result.residue.map((r) => `  waiting   ${r.node} needs ${r.edge} (${r.waiting} unconsumed)`)]
          : []),
        "",
        `  The topology declares what finishing looks like; this run stopped`,
        `  without producing it from a declared terminal. An intermediate`,
        `  instance of the same edge does not count — the terminal is what`,
        `  makes the end a real end rather than a type that happened to appear.`,
      ].join("\n"),
    };
  }

  if (result.residue.length > 0 && result.stopped === "quiescence") {
    return {
      code: 1,
      out: [
        `✗ stalled — reached quiescence with input still waiting`,
        ...detail,
        "",
        ...result.residue.map((r) => `  waiting   ${r.node} needs ${r.edge} (${r.waiting} unconsumed)`),
        "",
        `  Nothing will deliver these: no node fired in the last pulse. A node`,
        `  waiting on an edge whose producer routed elsewhere — a oneOf branch`,
        `  nothing consumes, a fan-in whose other arm never arrived, a gather`,
        `  whose spread produced more elements than reached it — is the usual`,
        `  cause. The log above has the lineage.`,
      ].join("\n"),
    };
  }

  return {
    code: 0,
    out: [
      `✓ ${result.stopped}`,
      ...detail,
      ...(result.residue.length > 0
        ? [
            "",
            ...result.residue.map((r) => `  waiting   ${r.node} needs ${r.edge} (${r.waiting} unconsumed)`),
            "",
            `  Expected after ${result.stopped}: a bounded run stops mid-flight.`,
          ]
        : []),
    ].join("\n"),
  };
}

/**
 * The planner (design.md §8,
 * docs/superpowers/specs/2026-09-28-the-planner.md).
 *
 * Search only — routes come back ordered by **depth**, which is a fact, not by
 * observed success rate, which needs runs of a real program this repo does not
 * have. §8 is explicit that weights must remain statistics rather than
 * parameters, so an unranked planner is the honest first half.
 */
async function planRoutes(from: string, to: string, dir: string, json: boolean): Promise<CliResult> {
  let program;
  try {
    program = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  for (const edge of [from, to]) {
    if (!(edge in program.edges)) {
      return { code: 1, out: `✗ no edge named "${edge}".\n\n  declared: ${Object.keys(program.edges).sort().join(", ")}` };
    }
  }

  const routes = plan(program, from, to);
  if (json) return { code: 0, out: JSON.stringify(routes, null, 2) };
  if (routes.length === 0) {
    return {
      code: 1,
      out: `✗ no route from "${from}" to "${to}".\n\n  No sequence of declared nodes makes "${to}" available starting from "${from}". Failure edges are deliberately not routed through.`,
    };
  }

  const lines = [`${routes.length} route(s) from ${from} to ${to}`, ""];
  for (const route of routes) {
    const tags = [`${route.depth} pulse${route.depth === 1 ? "" : "s"}`, `${route.nodes.length} nodes`];
    if (route.effectful.length > 0) tags.push(`effectful: ${route.effectful.join(", ")}`);
    if (route.crossings.length > 0) tags.push(`${route.crossings.length} zone crossing(s)`);
    lines.push(`  ${tags.join(", ")}`);
    lines.push(`    origins   ${route.wiring.origins.join(", ")}`);
    for (const [parent, children] of Object.entries(route.wiring.feeds)) {
      lines.push(`    ${parent} -> ${children.join(", ")}`);
    }
    lines.push("");
  }
  return { code: 0, out: lines.join("\n").trimEnd() };
}

/**
 * The `sys` queries (design.md §8) — everything derivable from the elaborated
 * program with no run required
 * (docs/superpowers/specs/2026-09-28-the-sys-queries.md).
 *
 * **Findings exit 0.** Unlike `check`, `test` and `run`, which each answer a
 * yes/no question, an orphaned edge may be a genuine mistake or an edge declared
 * ahead of the node that will use it — and that is not decidable here.
 */
async function sys(dir: string, flags: Map<string, string>, json: boolean): Promise<CliResult> {
  let program;
  try {
    program = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }

  const node = flags.get("node");
  if (node !== undefined) {
    if (!(node in program.nodes)) {
      const known = Object.keys(program.nodes).sort().join(", ") || "(none)";
      return { code: 1, out: `✗ no node named "${node}".\n\n  declared: ${known}` };
    }
    const result = mediation(program, node);
    if (json) return { code: 0, out: JSON.stringify(result, null, 2) };
    const lines = [`${node}`, ""];
    lines.push(
      result.mediates.length === 0
        ? `  mediates  nothing — no origin reaches a terminal only through it`
        : `  mediates  ${result.mediates.map((m) => `${m.origin} -> ${m.terminal}`).join(", ")}`,
    );
    lines.push(
      result.bypasses.length === 0
        ? `  bypassed  by nothing — every route crosses it`
        : `  bypassed  ${result.bypasses.map((b) => `${b.origin} -> ${b.terminal}`).join(", ")}`,
    );
    return { code: 0, out: lines.join("\n") };
  }

  const report = analyze(program);
  if (json) return { code: 0, out: JSON.stringify(report, null, 2) };

  const lines: string[] = [`${dir}`, ""];
  lines.push(`  edges     ${report.edges.length}`);
  for (const use of report.edges) {
    const from = use.producedBy.length === 0 ? "—" : use.producedBy.join(", ");
    const to = use.consumedBy.length === 0 ? "—" : use.consumedBy.join(", ");
    lines.push(`    ${use.edge.padEnd(24)} from ${from.padEnd(28)} to ${to}`);
  }
  if (report.refines.length > 0) {
    lines.push("", `  refines`);
    for (const r of report.refines) lines.push(`    ${r.edge.padEnd(24)} refines ${r.refines.padEnd(20)} (by ${r.by})`);
  }
  const zones = zoneOf(program);
  const hops = crossings(program);
  if (Object.keys(zones).length > 0) {
    lines.push("", `  zones`);
    // Only the nodes actually wired: inlining leaves a composite's inner nodes
    // under their original names too, and listing both places one node in its
    // zone twice. `zoneOf` still answers for them — the leftover really was
    // declared there — but the report is about this program.
    const wired = new Set([...program.wiring.origins, ...Object.values(program.wiring.feeds).flat()]);
    const byZone = new Map<string, string[]>();
    for (const [node, zone] of Object.entries(zones)) {
      if (!wired.has(node)) continue;
      byZone.set(zone, [...(byZone.get(zone) ?? []), node]);
    }
    for (const [zone, nodes] of [...byZone].sort()) lines.push(`    ${zone.padEnd(14)} ${nodes.sort().join(", ")}`);
    lines.push("", `  crossings`);
    if (hops.length === 0) lines.push(`    none — no edge crosses a declared zone boundary`);
    for (const h of hops) {
      const carries = h.carries.length === 0 ? "" : `  carries ${h.carries.join(", ")}`;
      lines.push(`    ${h.edge.padEnd(20)} ${h.from} (${h.fromZone}) -> ${h.to} (${h.toZone})${carries}`);
    }
  }
  if (report.unroutedFailureEdges > 0) {
    lines.push(`    ${String(report.unroutedFailureEdges).padStart(2)} synthesized Failed_* edge(s), none routed`);
  }
  if (report.unwiredNodes.length > 0) {
    lines.push("", `  unwired`);
    for (const n of report.unwiredNodes) lines.push(`    ${n} — declared, never wired into any topology`);
  }
  if (report.orphans.length > 0) {
    lines.push("", `  findings`);
    for (const o of report.orphans) {
      lines.push(
        o.kind === "orphaned"
          ? `    orphaned  ${o.edge} — nothing produces or consumes it`
          : `    dropped   ${o.edge} — produced by ${o.producedBy.join(", ")}, consumed by nothing, and not a declared terminal output`,
      );
    }
  }
  return { code: 0, out: lines.join("\n") };
}

/**
 * Runs every declared example in the program
 * (docs/superpowers/specs/2026-09-28-a-topology-can-be-tested.md).
 *
 * Testing, not acceptance: nothing is written, and a topology has nothing to
 * write — its body is its wiring. What this checks is whether a composition does
 * what its contract claims, which until now was checked by reading.
 */
async function test(dir: string, flags: Map<string, string>): Promise<CliResult> {
  const implRoot = flags.get("impl");
  if (implRoot === undefined) return { code: 1, out: `✗ test needs --impl.\n\n${USAGE}` };

  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }

  // Resolve implementations **per node**, tolerating the ones that are missing.
  // `elaborateWithImplementations` throws on the first unresolvable node, which
  // is right for `run` — a program that cannot execute should not start — and
  // wrong here: testing what exists while an agent implements the rest one node
  // at a time is the case this command is for. An unresolved node keeps its
  // declaration and gets no `fn`, which `runExamples` reports as a skip.
  const resolved = await Promise.all(
    Object.entries(elaborated.nodes).map(async ([name, decl]) => {
      try {
        return [name, await resolveImplementation(decl, resolve(implRoot))] as const;
      } catch {
        return [name, decl] as const;
      }
    }),
  );
  const program = { ...elaborated, nodes: Object.fromEntries(resolved) };
  const topologies = elaborated.topologies;

  const report = await runExamples(program, topologies);
  if (report.results.length === 0) {
    return { code: 1, out: `✗ no declared examples found in ${dir} — nothing was checked.` };
  }

  const lines: string[] = [];
  for (const r of report.results.filter((r) => r.outcome !== "passed")) {
    const label = `${r.kind} ${r.name} example ${r.index}`;
    if (r.outcome === "skipped") {
      lines.push(`  skipped   ${label} — ${r.reason}`);
      continue;
    }
    if (r.outcome === "effect") {
      lines.push(`  effect    ${label} — ${r.reason}`);
      continue;
    }
    lines.push(`  failed    ${label}${r.reason === undefined ? "" : ` — ${r.reason}`}`);
    if (r.expected !== undefined) lines.push(`            expected ${JSON.stringify(r.expected)}`);
    if (r.actual !== undefined) lines.push(`            actual   ${JSON.stringify(r.actual)}`);
  }

  const summary =
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped` +
    (report.effects > 0 ? `, ${report.effects} effect` : "");
  // **A skip is not a pass**, and a tick over a partly-skipped run would claim
  // more than was checked — the same rule `verify` follows when it refuses to
  // report a clean pass over zero checks. So a ✓ means every declared example
  // ran and agreed; anything else says which it was.
  //
  // This is strict during development on purpose: an agent implementing one
  // node at a time reads the skip list, which is the useful output either way,
  // and gets a green tick exactly when the program is actually finished.
  //
  // **An effect is not a skip and does not block the tick.** A skip says "not
  // implemented yet", which finishing the work clears. An effect node is never
  // going to have an `fn` — the runtime performs it through a host handler — so
  // counting it as a skip made a declared example on an effect node a permanent
  // red that no amount of implementing could fix. It is still never a pass:
  // nothing was checked, so it is listed and named, not folded into the count.
  const clean = report.failed === 0 && report.skipped === 0 && report.passed > 0;
  const headline = clean
    ? `✓ ${summary}`
    : report.failed > 0
      ? `✗ ${summary}`
      : `✗ ${summary} — nothing failed, but a skip is not a pass`;
  return { code: clean ? 0 : 1, out: [headline, ...(lines.length > 0 ? ["", ...lines] : [])].join("\n") };
}

/**
 * Runs one candidate implementation through the acceptance gate — its declared
 * examples, generated structural cases, and property assertions — and persists
 * it only if it passes (docs/design.md §10).
 *
 * The gate existed with no way to reach it: `acceptImplementation`'s only
 * callers were tests, which is most of why nobody noticed that a `.node` file's
 * examples could not pass it at all
 * (docs/superpowers/specs/2026-09-28-examples-reach-the-gate.md).
 */
async function accept(nodeName: string, dir: string, flags: Map<string, string>): Promise<CliResult> {
  const implRoot = flags.get("impl");
  const sourcePath = flags.get("source");
  if (implRoot === undefined || sourcePath === undefined) {
    return { code: 1, out: `✗ accept needs --source and --impl.\n\n${USAGE}` };
  }

  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  const node = elaborated.nodes[nodeName];
  if (node === undefined) {
    const known = Object.keys(elaborated.nodes).sort().join(", ") || "(none)";
    return { code: 1, out: `✗ no node named "${nodeName}".\n\n  declared: ${known}` };
  }

  let source: string;
  try {
    source = await readFile(resolve(sourcePath), "utf8");
  } catch (error) {
    return { code: 1, out: `✗ could not read --source ${sourcePath}\n\n  ${(error as Error).message}` };
  }

  const result = await acceptImplementation(node, source, resolve(implRoot));
  if (result.accepted) {
    return {
      code: 0,
      out: [`✓ accepted ${nodeName}`, "", `  impl      ${result.path}`, `  metadata  ${result.metadataPath}`].join("\n"),
    };
  }
  if (result.reason === "load-failed") {
    return { code: 1, out: [`✗ ${nodeName} did not load`, "", `  ${result.error}`].join("\n") };
  }

  // Nothing was written — accept-before-persist means a rejected candidate
  // leaves no trace, so the report is the only record of why.
  const lines = [`✗ ${nodeName} was not accepted`, ""];
  for (const failed of result.exampleFailures) {
    lines.push(`  example   given ${JSON.stringify(failed.given)}`);
    lines.push(`            expected ${JSON.stringify(failed.expected)}`);
    lines.push(`            actual   ${JSON.stringify(failed.actual)}`);
  }
  for (const failed of result.fuzzReport.failures.slice(0, 5)) {
    lines.push(`  generated ${JSON.stringify(failed.input)} — ${failed.error}`);
  }
  for (const failed of result.fuzzReport.propertyFailures.slice(0, 5)) {
    lines.push(`  property  "${failed.property}" did not hold for ${JSON.stringify(failed.input)}`);
  }
  if (result.vacuous) {
    lines.push(`  vacuous   no generated case produced a real output, so every property passed on nothing`);
  }
  return { code: 1, out: lines.join("\n") };
}

/** Replays each recorded invocation against the implementation its contract hash pins. No verdict — that is `verify`. */
async function replay(dir: string, flags: Map<string, string>): Promise<CliResult> {
  const implRoot = flags.get("impl");
  const runId = flags.get("run");
  if (implRoot === undefined || runId === undefined) {
    return { code: 1, out: `✗ replay needs --impl and --run.\n\n${USAGE}` };
  }
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  const entries = FileTrace.open(resolve(flags.get("trace") ?? "weir-trace.jsonl")).entries(runId);
  if (entries.length === 0) return { code: 1, out: `✗ no recorded invocations for run "${runId}".` };

  const lines: string[] = [];
  for (const entry of entries) {
    const node = elaborated.nodes[entry.envelope.node];
    if (node === undefined) {
      lines.push(`  ? ${entry.envelope.node.padEnd(28)} not declared in this program`);
      continue;
    }
    try {
      const result = await replayInvocation(entry, node, resolve(implRoot));
      lines.push(`  · ${entry.envelope.node.padEnd(28)} ${JSON.stringify(result)}`);
    } catch (error) {
      lines.push(`  ✗ ${entry.envelope.node.padEnd(28)} ${(error as Error).message}`);
    }
  }
  return { code: 0, out: [`replayed ${entries.length} invocation(s) of run ${runId}`, "", ...lines].join("\n") };
}

/** Replays and compares. A mismatch is evidence the node read something its contract does not declare. */
/**
 * Re-execute a recorded run under the **current** declarations, into a new run
 * (docs/superpowers/specs/2026-09-29-drift-and-fork.md).
 *
 * Takes no `--effects`: every effect is answered from the parent's trace, which
 * is what makes a fork deterministic and runnable with no credentials.
 */
async function fork(dir: string, flags: Map<string, string>, parent: string): Promise<CliResult> {
  const implRoot = flags.get("impl");
  if (implRoot === undefined) return { code: 1, out: `✗ fork needs --impl.\n\n${USAGE}` };

  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }

  const tracePath = resolve(flags.get("trace") ?? "weir-trace.jsonl");
  const entries = FileTrace.open(tracePath).entries(parent);
  if (entries.length === 0) {
    return { code: 1, out: `✗ no recorded invocations for run "${parent}" in ${tracePath}.` };
  }

  const plan = await planFork(elaborated, entries, resolve(implRoot));

  // Reported before anything is written. Widening an edge moves the contract
  // hash of every node naming it, and an implementation resolves *by* contract
  // hash — so immediately after a widening those nodes have no accepted
  // implementation. That is the acceptance gate working, and a fork that failed
  // opaquely here would look like a bug in the fork rather than work still to
  // do (spec §6).
  if (plan.blocked.length > 0) {
    return {
      code: 1,
      out: [
        `✗ cannot fork "${parent}" yet — ${plan.blocked.length} node(s) need an accepted implementation`,
        "",
        ...plan.blocked.map((b) => `  blocked   ${b.node.padEnd(24)} contract ${b.contractHash}`),
        "",
        `  A changed declaration is a changed contract, and nothing has been`,
        `  accepted against the new one. Draft and \`weir accept\` each, then fork.`,
        ...(plan.divergesAt === undefined ? [] : ["", `  diverges at  ${plan.divergesAt}`]),
      ].join("\n"),
    };
  }

  const program = {
    ...elaborated,
    nodes: await bindResolvable(elaborated, resolve(implRoot)),
  } as unknown as Parameters<typeof runNetlist>[0];

  // The parent's own trigger, replayed: a fork re-asks the same question of a
  // changed program, so inventing a new payload would change two things at once.
  const originPayloads: Record<string, unknown> = {};
  for (const entry of entries) {
    if (program.wiring.origins.includes(entry.envelope.node) && !(entry.envelope.node in originPayloads)) {
      originPayloads[entry.envelope.node] = entry.input;
    }
  }

  const correlationId = flags.get("run") ?? `${parent}-fork-${crypto.randomUUID().slice(0, 8)}`;
  const logPath = resolve(flags.get("log") ?? "weir.jsonl");
  const log = FileLog.open(logPath);
  const trace = FileTrace.open(tracePath);

  const result = await runNetlist(
    program,
    { correlationId, originPayloads, forkedFrom: parent },
    { log, trace, effects: plan.effects },
  );

  return {
    code: result.unmet.length > 0 || (result.residue.length > 0 && result.stopped === "quiescence") ? 1 : 0,
    out: [
      result.unmet.length > 0 ? `✗ forked, but did not reach its declared end` : `✓ ${result.stopped}`,
      "",
      `  run       ${correlationId}`,
      `  forked    ${parent}`,
      ...(plan.divergesAt === undefined
        ? [`  diverges  nothing — every contract matches the recording`]
        : [`  diverges  ${plan.divergesAt}`]),
      `  effects   ${plan.recordedEffects} answered from the recording, 0 performed`,
      `  firings   ${result.firings}`,
      `  log       ${logPath}`,
      ...(result.unmet.length > 0
        ? ["", ...result.unmet.map((u) => `  missing   ${u.missing.join(", ")} from ${u.terminals.join(", ")}`)]
        : []),
    ].join("\n"),
  };
}

async function verify(dir: string, flags: Map<string, string>): Promise<CliResult> {
  const implRoot = flags.get("impl");
  const runId = flags.get("run");
  if (implRoot === undefined || runId === undefined) {
    return { code: 1, out: `✗ verify needs --impl and --run.\n\n${USAGE}` };
  }
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  const entries = FileTrace.open(resolve(flags.get("trace") ?? "weir-trace.jsonl")).entries(runId);
  if (entries.length === 0) return { code: 1, out: `✗ no recorded invocations for run "${runId}".` };

  const report = await verifyRun(entries, elaborated.nodes, resolve(implRoot));
  const skipped = report.skipped.map((s) => `  ? ${s.node.padEnd(28)} ${s.reason}`);
  // Never folded into the pass count: an effect's replay is its own record,
  // so the comparison can only ever agree with itself.
  const effects = report.declaredNondeterministic.map(
    (d) => `  ~ ${d.node.padEnd(28)} effect "${d.effect}" — nondeterminism enters here by declaration`,
  );

  if (report.mismatches.length === 0) {
    return {
      code: 0,
      out: [
        `✓ ${report.checked} invocation(s) replayed identically`,
        ...(effects.length > 0 ? ["", `  ${effects.length} declared nondeterministic:`, ...effects] : []),
        ...(skipped.length > 0 ? ["", `  ${skipped.length} not checked:`, ...skipped] : []),
        "",
        // Said plainly rather than implied: this finds violations, it does
        // not certify their absence. A clock read at second granularity
        // passes when the replay lands in the same second.
        `  (a clean result is evidence, not proof — nondeterminism that agrees twice is invisible here)`,
      ].join("\n"),
    };
  }

  const detail = report.mismatches.flatMap((m) => [
    `  ✗ ${m.node}  (invocation ${m.invocationId})`,
    `      input     ${JSON.stringify(m.input)}`,
    `      recorded  ${JSON.stringify(m.recorded)}`,
    `      replayed  ${JSON.stringify(m.replayed)}`,
  ]);
  return {
    code: 1,
    out: [
      `✗ ${report.mismatches.length} of ${report.checked} invocation(s) did not replay identically`,
      "",
      ...detail,
      ...(effects.length > 0 ? ["", `  ${effects.length} declared nondeterministic:`, ...effects] : []),
      ...(skipped.length > 0 ? ["", `  ${skipped.length} not checked:`, ...skipped] : []),
      "",
      // The pin is implementation-shaped now: a changed implementation is
      // refused by replay and arrives above as a skip, so what reaches here
      // is attributable to the node.
      `  These nodes read something their contracts do not declare. Both the`,
      `  contract and the implementation are unchanged since the run — replay`,
      `  refuses either kind of drift — so the difference is the node itself.`,
    ].join("\n"),
  };
}

async function contract(nodeName: string, dir: string): Promise<CliResult> {
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  const node = elaborated.nodes[nodeName];
  if (node === undefined) {
    const known = Object.keys(elaborated.nodes).sort().join(", ");
    return { code: 1, out: `✗ no node named "${nodeName}".\n\n  declared: ${known}` };
  }
  return { code: 0, out: JSON.stringify(exportContract(node), null, 2) };
}

/**
 * Emits the node's input and output edges as a zod module — piece 1 of
 * docs/superpowers/specs/2026-10-01-the-deterministic-scaffold.md.
 *
 * A sealed contract is a JSON document, so an agent drafting against it has no
 * name to refer to and writes `p: any`. A schema rather than a type because a
 * type discards the validations: `lng` declaring `min: -180, max: 180` becomes
 * `lng: number`, and a declared `uint8` becomes `number`.
 */
async function emitZod(nodeName: string, dir: string): Promise<CliResult> {
  let elaborated;
  try {
    elaborated = await elaborate(dir);
  } catch (error) {
    return failure(error, dir);
  }
  const node = elaborated.nodes[nodeName];
  if (node === undefined) {
    const known = Object.keys(elaborated.nodes).sort().join(", ");
    return { code: 1, out: `✗ no node named "${nodeName}".\n\n  declared: ${known}` };
  }
  return { code: 0, out: emitZodModule(node) };
}

/** Parses argv (without node/script) and runs the command. Never writes, never exits. */
export async function runCli(argv: string[], cwd: string): Promise<CliResult> {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    // `--json` is a bare switch; every other flag takes the next argument.
    if (name === "json") {
      flags.set("json", "true");
      continue;
    }
    i += 1;
    flags.set(name, argv[i] ?? "");
  }
  const json = flags.has("json");
  const [command, ...rest] = positional;

  switch (command) {
    case "check":
      return check(rest[0] ?? cwd);
    case "graph":
      return graph(rest[0] ?? cwd, json);
    case "run":
      return run(rest[0] ?? cwd, flags);
    case "replay":
      return replay(rest[0] ?? cwd, flags);
    case "fork": {
      const parent = flags.get("from");
      if (parent === undefined) return { code: 1, out: `✗ fork needs --from <run-id>.\n\n${USAGE}` };
      return fork(rest[0] ?? cwd, flags, parent);
    }
    case "verify":
      return verify(rest[0] ?? cwd, flags);
    case "plan": {
      if (rest[0] === undefined || rest[1] === undefined) {
        return { code: 1, out: `✗ plan needs a from-edge and a to-edge.\n\n${USAGE}` };
      }
      return planRoutes(rest[0], rest[1], rest[2] ?? cwd, argv.includes("--json"));
    }
    case "sys":
      return sys(rest[0] ?? cwd, flags, argv.includes("--json"));
    case "test":
      return test(rest[0] ?? cwd, flags);
    case "accept": {
      if (rest[0] === undefined) return { code: 1, out: `✗ accept needs a node name.\n\n${USAGE}` };
      return accept(rest[0], rest[1] ?? cwd, flags);
    }
    case "contract": {
      if (rest[0] === undefined) return { code: 1, out: `✗ contract needs a node name.\n\n${USAGE}` };
      return contract(rest[0], rest[1] ?? cwd);
    }
    case "emit-zod": {
      if (rest[0] === undefined) return { code: 1, out: `✗ emit-zod needs a node name.\n\n${USAGE}` };
      return emitZod(rest[0], rest[1] ?? cwd);
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { code: 0, out: USAGE };
    default:
      return { code: 1, out: `✗ unknown command "${command}".\n\n${USAGE}` };
  }
}
