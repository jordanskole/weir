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
import { elaborate } from "./elaborate.js";
import { serializeNetlist } from "./netlist.js";
import { exportContract } from "./contract.js";
import { elaborateWithImplementations } from "./implementation.js";
import { runNetlist } from "./runtime.js";
import { FileLog } from "./file-log.js";
import { FileTrace } from "./file-trace.js";
import { replayInvocation } from "./replay.js";
import { verifyRun } from "./verify.js";

export interface CliResult {
  code: number;
  out: string;
}

const USAGE = `weir — a declarative framework of pure nodes wired by data schemas

usage
  weir check [dir]              elaborate the declarations and report what fails
  weir graph [dir] [--json]     print the topology, or the netlist as JSON
  weir contract <node> [dir]    print one node's sealed contract, as an agent receives it
  weir run [dir] --impl <dir> --payload <file.json> [--log <file>] [--run <id>]
                                elaborate, resolve implementations, and execute
  weir replay [dir] --impl <dir> --run <id> [--trace <file>]
                                re-run each recorded invocation against its pinned implementation
  weir verify [dir] --impl <dir> --run <id> [--trace <file>]
                                replay and compare — a mismatch means undeclared nondeterminism

  dir defaults to the current directory.
  --payload is a JSON object of origin node name -> that node's payload.
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
      "",
      // Errors do not name the file they came from yet. Saying so is better
      // than letting someone hunt for it and conclude the tool is careless.
      `  (declarations are not yet reported with the file they came from)`,
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

  // Worth naming rather than letting the run quietly do nothing: an origin
  // with no payload is never offered as a candidate, so the symptom would be
  // a graph reaching quiescence having fired nothing, with no error at all.
  const missing = program.wiring.origins.filter((o) => !(o in originPayloads));
  if (missing.length > 0) {
    return {
      code: 1,
      out: `✗ no payload for origin(s) ${missing.map((m) => `"${m}"`).join(", ")}.\n\n  --payload must name every origin: ${program.wiring.origins.join(", ")}`,
    };
  }

  const logPath = resolve(flags.get("log") ?? "weir.jsonl");
  const tracePath = resolve(flags.get("trace") ?? "weir-trace.jsonl");
  const log = FileLog.open(logPath);
  const trace = FileTrace.open(tracePath);
  const correlationId = flags.get("run") ?? crypto.randomUUID();
  const result = await runNetlist(program, { correlationId, originPayloads }, { log, trace });

  return {
    code: 0,
    out: [
      `✓ ${result.stopped}`,
      "",
      `  run       ${correlationId}`,
      `  firings   ${result.firings}`,
      `  pulses    ${result.pulses}`,
      `  log       ${logPath}`,
      `  trace     ${tracePath}`,
    ].join("\n"),
  };
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
      // The pin is contract-shaped, so a mismatch has two possible causes and
      // the output must not accuse the node of the wrong one.
      `  Either the node read something its contract does not declare, or the`,
      `  implementation changed since the run — the version pin pins the`,
      `  contract, not the implementation (docs/open-questions.md).`,
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
    case "verify":
      return verify(rest[0] ?? cwd, flags);
    case "contract": {
      if (rest[0] === undefined) return { code: 1, out: `✗ contract needs a node name.\n\n${USAGE}` };
      return contract(rest[0], rest[1] ?? cwd);
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
