/**
 * The command-line surface, kept deliberately small: the three things that
 * need nothing weir has not built.
 *
 * `check` and `graph` and `contract` are all pure functions of a directory
 * of declarations — no log, no implementations, no runtime. That is why they
 * can ship while `run` cannot: `InMemoryLog` is the only `Log` there is, so
 * a run starts empty and dies with the process (readme.md's "not built yet:
 * ... any log that outlives the process"). A `weir run` would be a demo, not
 * a tool, and shipping it as one would misrepresent how finished this is.
 *
 * The core is `runCli(argv, cwd)`, returning a code and the text to print,
 * rather than a function that writes to stdout and calls `process.exit`.
 * That is the difference between a CLI whose behaviour is unit-testable and
 * one whose behaviour is only observable by shelling out — and this CLI's
 * whole point is its *errors*, which are exactly the thing worth asserting
 * on.
 */

import { elaborate } from "./elaborate.js";
import { serializeNetlist } from "./netlist.js";
import { exportContract } from "./contract.js";

export interface CliResult {
  code: number;
  out: string;
}

const USAGE = `weir — a declarative framework of pure nodes wired by data schemas

usage
  weir check [dir]              elaborate the declarations and report what fails
  weir graph [dir] [--json]     print the topology, or the netlist as JSON
  weir contract <node> [dir]    print one node's sealed contract, as an agent receives it

  dir defaults to the current directory.

Every command reads .field/.edge/.node/.topology files and nothing else.
There is deliberately no "run": the only Log is in-memory, so a run would
not outlive the process.`;

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
  const args = argv.filter((a) => a !== "--json");
  const json = argv.includes("--json");
  const [command, ...rest] = args;

  switch (command) {
    case "check":
      return check(rest[0] ?? cwd);
    case "graph":
      return graph(rest[0] ?? cwd, json);
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
