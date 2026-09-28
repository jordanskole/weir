import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

/**
 * A root `.topology`: its contract plus its wiring, the shape required since
 * docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md.
 * `output`/`terminals` say what finishing looks like; the wiring is indented
 * under `wiring:` exactly as a composite's is.
 */
const rootTopology = (input: string, output: string, terminals: string[], wiring: string): string =>
  `input: ${input}\n` +
  `${output.includes("\n") ? `output:\n${output}` : `output: ${output}\n`}terminals:\n` +
  terminals.map((t) => `  - ${t}\n`).join("") +
  "wiring:\n" +
  wiring
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");


const SOC_SRC = fileURLToPath(new URL("../../../examples/soc-triage/src", import.meta.url));
const RECIPE_SRC = fileURLToPath(new URL("../../../examples/recipe/src", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-cli-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const EDGE = (name: string) => `label: E\ndescription: ${name}\nfields:\n  v:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`;

describe("runCli", () => {
  it("check: succeeds on a real example, counting authored declarations rather than synthesized ones", async () => {
    const result = await runCli(["check", RECIPE_SRC], "/nowhere");

    expect(result.code).toBe(0);
    // Four authored nodes. A count that silently included every synthesized
    // `Failed_*` edge and `noop_*` node would read as though the author wrote
    // twice what they wrote.
    expect(result.out).toContain("4 node(s)");
    expect(result.out).toContain("2 origin(s): mix, preheatOven");
  });

  it("check: names the file a bad declaration came from", async () => {
    // "which file?" is the first question anyone asks when check fails, and
    // until this landed the output apologised for not answering it.
    const root = await fixture({
      "edges/Good.edge": EDGE("Good"),
      "edges/nested/Bad.edge": `label: E\ndescription: B\nfields:\n  v:\n    type: notatype\n    label: V\n    description: d\n    nullable: false\n`,
    });

    const result = await runCli(["check", root], "/nowhere");

    expect(result.code).toBe(1);
    expect(result.out).toContain("edges/nested/Bad.edge");
    // And the apology is gone, because the question is answered.
    expect(result.out).not.toContain("not yet reported with the file");
  });

  it("check: reports a wiring failure as a message, with a non-zero code and no stack trace", async () => {
    // The errors are the product — this is the assertion that matters.
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/makeA.node": `label: MA\ndescription: d\ninput: A\noutput: A\nexamples:\n  - given:\n      A: {}\n    expect:\n      A: {}\n`,
      "nodes/needsB.node": `label: NB\ndescription: d\ninput: B\noutput: B\nexamples:\n  - given:\n      B: {}\n    expect:\n      B: {}\n`,
      "topology/main.topology": rootTopology("A", "B", ["needsB"], `makeA:\n  then:\n    needsB: {}\n`),
    });

    const result = await runCli(["check", root], "/nowhere");

    expect(result.code).toBe(1);
    expect(result.out).toContain(`the arc "makeA" -> "needsB" carries nothing`);
    expect(result.out).not.toContain("at ");
    expect(result.out).not.toContain("node_modules");
  });

  it("check: reports a node that can never become ready", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/makeA.node": `label: MA\ndescription: d\ninput: A\noutput: A\nexamples:\n  - given:\n      A: {}\n    expect:\n      A: {}\n`,
      "nodes/join.node": `label: J\ndescription: d\ninput:\n  allOf:\n    - A\n    - B\noutput: B\nexamples:\n  - given:\n      A: {}\n      B: {}\n    expect:\n      B: {}\n`,
      "topology/main.topology": rootTopology("A", "B", ["join"], `makeA:\n  then:\n    join: {}\n`),
    });

    const result = await runCli(["check", root], "/nowhere");

    expect(result.code).toBe(1);
    expect(result.out).toContain(`"join" declares needing "B"`);
  });

  it("graph: prints one line per arc, with the edge each carries", async () => {
    const result = await runCli(["graph", SOC_SRC], "/nowhere");

    expect(result.code).toBe(0);
    expect(result.out).toContain("origin  extractEntities");
    // An inlined composite's nodes appear by position, which is what the
    // wiring actually contains.
    expect(result.out).toContain("investigate/investigateIdentity -> assembleEvidence");
    expect(result.out).toContain("many Entity");
  });

  it("graph --json: emits the netlist", async () => {
    const result = await runCli(["graph", SOC_SRC, "--json"], "/nowhere");

    expect(result.code).toBe(0);
    const netlist = JSON.parse(result.out);
    expect(netlist.topology.origins).toBeDefined();
  });

  it("contract: emits one node's sealed contract, and lists the nodes when the name is wrong", async () => {
    const ok = await runCli(["contract", "assess", SOC_SRC], "/nowhere");
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).node).toBe("assess");

    const bad = await runCli(["contract", "assesss", SOC_SRC], "/nowhere");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("assess");
  });

  it("help: is the default, and an unknown command fails with it", async () => {
    expect((await runCli([], "/nowhere")).code).toBe(0);
    expect((await runCli([], "/nowhere")).out).toContain("weir check");

    const unknown = await runCli(["frobnicate"], "/nowhere");
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain(`unknown command "frobnicate"`);
    // The help names Principle 0 and which command checks it, because that
    // is the least obvious thing about the surface.
    expect(unknown.out).toContain("weir verify");
    expect(unknown.out).toContain("Principle 0");
  });
});

describe("runCli — run", () => {
  it("executes a real example end to end and leaves a readable log", async () => {
    const workdir = await fixture({});
    const implRoot = join(workdir, "impl");
    for (const [node, fn] of [
      ["mix", `export default function mix(p) { return { title: p.title, servings: p.servings }; }`],
      ["preheatOven", `export default function preheatOven(p) { return { temperature: p.temperature, preheated: true }; }`],
      ["bake", `export default function bake(b) { return { title: b.Dough.title, servings: b.Dough.servings, done: false }; }`],
      ["cool", `export default function cool(p) { return { ...p, done: true }; }`],
    ] as const) {
      const { hashNode } = await import("./hash.js");
      const { elaborate } = await import("./elaborate.js");
      const hash = (await hashNode((await elaborate(RECIPE_SRC)).nodes[node]!)).short;
      await mkdir(join(implRoot, node), { recursive: true });
      await writeFile(join(implRoot, node, `${hash}.ts`), `${fn}\n`, "utf8");
    }
    const recipe = { title: "Chocolate Chip Cookies", servings: 24, temperature: 375, ingredients: {} };
    const payload = join(workdir, "payload.json");
    // One external event, one payload. Both origins declare `input: Recipe` and
    // are populated from it — this used to name each origin separately and write
    // the same recipe twice (2026-09-28-a-topology-declares-its-beginning.md).
    await writeFile(payload, JSON.stringify(recipe), "utf8");
    const logPath = join(workdir, "weir.jsonl");

    const result = await runCli(
      ["run", RECIPE_SRC, "--impl", implRoot, "--payload", payload, "--log", logPath, "--run", "r1"],
      workdir,
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("quiescence");
    expect(result.out).toContain("firings   4");

    // The log outlives the process, which is the whole point: read it back
    // with no runtime involved.
    const { FileLog } = await import("./file-log.js");
    const reloaded = FileLog.open(logPath);
    expect(reloaded.latest("Cookies", "r1")).toEqual({
      title: recipe.title,
      servings: recipe.servings,
      done: true,
    });
  });

  it("refuses a run whose origins have no payload, rather than firing nothing", async () => {
    // Without this the symptom is a graph reaching quiescence having done no
    // work, with exit 0 and no error — the failure mode this whole project
    // has been chasing all week.
    const workdir = await fixture({});
    const payload = join(workdir, "payload.json");
    await writeFile(payload, JSON.stringify({}), "utf8");

    const result = await runCli(
      ["run", RECIPE_SRC, "--impl", join(workdir, "impl"), "--payload", payload],
      workdir,
    );

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/no payload for origin|No accepted implementation/);
  });

  it("needs --impl and --payload", async () => {
    const result = await runCli(["run", RECIPE_SRC], "/nowhere");
    expect(result.code).toBe(1);
    expect(result.out).toContain("--impl and --payload");
  });
});

describe("runCli — verify", () => {
  /** Runs a one-node program end to end, then returns what verify says about it. */
  async function runThenVerify(fn: string): Promise<{ run: Awaited<ReturnType<typeof runCli>>; verify: Awaited<ReturnType<typeof runCli>> }> {
    const workdir = await fixture({
      "edges/Reading.edge": `label: E\ndescription: R\nfields:\n  value:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`,
      "nodes/observe.node": `label: O\ndescription: d\ninput: Reading\noutput: Reading\nexamples:\n  - given:\n      Reading: {}\n    expect:\n      Reading: {}\n`,
      "topology/main.topology": rootTopology("Reading", "Reading", ["observe"], `observe: {}\n`),
    });
    const { hashNode } = await import("./hash.js");
    const { elaborate } = await import("./elaborate.js");
    const hash = (await hashNode((await elaborate(workdir)).nodes.observe!)).short;
    const implRoot = join(workdir, "impl");
    await mkdir(join(implRoot, "observe"), { recursive: true });
    await writeFile(join(implRoot, "observe", `${hash}.ts`), `${fn}\n`, "utf8");
    const payload = join(workdir, "payload.json");
    await writeFile(payload, JSON.stringify({ value: "x" }), "utf8");

    const common = [workdir, "--impl", implRoot, "--run", "r1", "--trace", join(workdir, "t.jsonl")];
    const run = await runCli(["run", ...common, "--log", join(workdir, "l.jsonl"), "--payload", payload], workdir);
    const verify = await runCli(["verify", ...common], workdir);
    return { run, verify };
  }

  it("passes a deterministic node, and says a clean result is evidence rather than proof", async () => {
    const { run, verify } = await runThenVerify(
      `export default function observe(r) { return { value: r.value + "!" }; }`,
    );

    expect(run.code).toBe(0);
    expect(verify.code).toBe(0);
    expect(verify.out).toContain("1 invocation(s) replayed identically");
    expect(verify.out).toContain("evidence, not proof");
  });

  it("fails a node that reads a clock, and attributes it to the node", async () => {
    const { verify } = await runThenVerify(
      `export default function observe(r) { return { value: r.value + process.hrtime.bigint().toString() }; }`,
    );

    expect(verify.code).toBe(1);
    expect(verify.out).toContain("did not replay identically");
    expect(verify.out).toContain("recorded");
    expect(verify.out).toContain("replayed");
    // The pin is implementation-shaped now, so replay refuses a changed
    // implementation and it arrives as a skip. A mismatch that reaches here
    // is attributable to the node.
    expect(verify.out).toContain("read something their contracts do not declare");
    expect(verify.out).toContain("unchanged since the run");
  });
});

/**
 * Spec Testing #6 (2026-09-27-quiescence-is-not-success.md). The exit code is
 * the assertion that matters — the whole point is that a script notices, and a
 * run that stalls used to print `✓ quiescence` and exit 0.
 */
describe("runCli — run reports a stall", () => {
  /**
   * A spread whose element is routed to a branch nothing consumes, so the
   * gather waits for two and only ever sees one. `Skipped` is not a failure —
   * that is what makes this invisible to gather's own deadness rule.
   */
  async function stallingFixture(): Promise<{ workdir: string; implRoot: string; payload: string }> {
    const indexed = (name: string, index: string) =>
      `label: ${name}\ndescription: d\nindex: ${index}\nfields:\n  ${index}:\n    type: utf8\n    label: I\n    description: d\n    nullable: false\n`;
    const workdir = await fixture({
      "edges/Seed.edge": EDGE("Seed"),
      "edges/Item.edge": indexed("Item", "id"),
      "edges/Looked.edge": indexed("Looked", "itemId"),
      "edges/Skipped.edge": indexed("Skipped", "itemId"),
      "edges/Summary.edge": `label: Summary\ndescription: d\nfields:\n  n:\n    type: uint8\n    label: N\n    description: d\n    nullable: false\n    validations:\n      min: 0\n      max: 255\n`,
      "nodes/explode.node":
        `label: Explode\ndescription: d\ninput: Seed\noutput:\n  many: Item\n` +
        `examples:\n  - given:\n      Seed:\n        v: "x"\n    expect:\n      Item:\n        a:\n          id: "a"\n`,
      "nodes/lookOrSkip.node":
        `label: Look\ndescription: d\ninput: Item\noutput:\n  oneOf:\n    - Looked\n    - Skipped\n` +
        `examples:\n  - given:\n      Item:\n        id: "a"\n    expect:\n      Looked:\n        itemId: "a"\n`,
      "nodes/summarize.node":
        `label: Sum\ndescription: d\ninput:\n  gather: Looked\noutput: Summary\n` +
        `examples:\n  - given:\n      Looked:\n        a:\n          itemId: "a"\n    expect:\n      Summary:\n        n: 1\n`,
      "topology/main.topology": rootTopology("Seed", "Summary", ["summarize"], `explode:\n  then:\n    lookOrSkip:\n      then:\n        summarize: {}\n`),
    });

    const { hashNode } = await import("./hash.js");
    const { elaborate } = await import("./elaborate.js");
    const nodes = (await elaborate(workdir)).nodes;
    const impls: Record<string, string> = {
      explode: `export default function explode() { return { a: { id: "a" }, b: { id: "b" } }; }`,
      lookOrSkip: `export default function lookOrSkip(i) {
  return i.id === "a"
    ? { edge: "Looked", payload: { itemId: i.id } }
    : { edge: "Skipped", payload: { itemId: i.id } };
}`,
      summarize: `export default function summarize(c) { return { n: Object.keys(c).length }; }`,
    };
    const implRoot = join(workdir, "impl");
    for (const [name, fn] of Object.entries(impls)) {
      const hash = (await hashNode(nodes[name]!)).short;
      await mkdir(join(implRoot, name), { recursive: true });
      await writeFile(join(implRoot, name, `${hash}.ts`), `${fn}\n`, "utf8");
    }
    const payload = join(workdir, "payload.json");
    await writeFile(payload, JSON.stringify({ v: "x" }), "utf8");
    return { workdir, implRoot, payload };
  }

  it("exits non-zero and names the waiting node, where it used to print a checkmark", async () => {
    const { workdir, implRoot, payload } = await stallingFixture();

    const result = await runCli(
      [
        "run",
        workdir,
        "--impl",
        implRoot,
        "--run",
        "r1",
        "--payload",
        payload,
        "--log",
        join(workdir, "l.jsonl"),
        "--trace",
        join(workdir, "t.jsonl"),
      ],
      workdir,
    );

    // The assertion both specs are about: a script can tell.
    expect(result.code).toBe(1);

    // This fixture is *both* things at once, which is the point of Testing #8
    // in 2026-09-28-a-root-topology-declares-its-end.md: it never reached its
    // declared end, *and* a node is left waiting. Neither message replaces the
    // other — the unmet end says what went wrong, the residue says where.
    expect(result.out).toContain("did not reach its declared end");
    expect(result.out).toContain("Summary");
    // Named specifically enough to act on without re-running.
    expect(result.out).toContain("summarize needs Looked");
    expect(result.out).toContain("1 unconsumed");
    // And it must not also claim success.
    expect(result.out).not.toContain("✓");
  });

  it("still exits zero, with no waiting line, for a run that completes", async () => {
    // The guard against a check that fires on healthy runs — the failure mode
    // that gets a safeguard switched off. `examples/recipe` runs clean.
    const workdir = await fixture({ "placeholder.txt": "" });
    const { hashNode } = await import("./hash.js");
    const { elaborate } = await import("./elaborate.js");
    const nodes = (await elaborate(RECIPE_SRC)).nodes;
    const impls: Record<string, string> = {
      mix: `export default function mix(r) { return { title: r.title, servings: r.servings }; }`,
      preheatOven: `export default function preheatOven(r) { return { temperature: r.temperature, preheated: true }; }`,
      bake: `export default function bake(b) { return { title: b.Dough.title, servings: b.Dough.servings, done: false }; }`,
      cool: `export default function cool(c) { return { ...c, done: true }; }`,
    };
    const implRoot = join(workdir, "impl");
    for (const [name, fn] of Object.entries(impls)) {
      const hash = (await hashNode(nodes[name]!)).short;
      await mkdir(join(implRoot, name), { recursive: true });
      await writeFile(join(implRoot, name, `${hash}.ts`), `${fn}\n`, "utf8");
    }
    const payload = join(workdir, "payload.json");
    // One Recipe, feeding both origins through the entry topology's declared input.
    await writeFile(
      payload,
      JSON.stringify({ title: "Chocolate Chip Cookies", servings: 24, temperature: 375, ingredients: {} }),
      "utf8",
    );

    const result = await runCli(
      [
        "run",
        RECIPE_SRC,
        "--impl",
        implRoot,
        "--run",
        "r1",
        "--payload",
        payload,
        "--log",
        join(workdir, "l.jsonl"),
        "--trace",
        join(workdir, "t.jsonl"),
      ],
      workdir,
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("✓ quiescence");
    expect(result.out).not.toContain("waiting");
  });
});

/**
 * `weir accept` — the gate, reachable
 * (docs/superpowers/specs/2026-09-28-examples-reach-the-gate.md §4). It existed
 * with no CLI entry at all, which is most of why nobody noticed that a `.node`
 * file's examples could not pass it.
 */
describe("runCli — accept", () => {
  it("accepts a correct implementation of a real example node, and persists it", async () => {
    const workdir = await fixture({ "placeholder.txt": "" });
    const source = join(workdir, "mix.ts");
    await writeFile(source, `export default function mix(r) { return { title: r.title, servings: r.servings }; }\n`, "utf8");
    const implRoot = join(workdir, "impl");

    const result = await runCli(["accept", "mix", RECIPE_SRC, "--source", source, "--impl", implRoot], workdir);

    expect(result.code).toBe(0);
    expect(result.out).toContain("✓ accepted mix");
    expect(result.out).toContain("metadata");
  });

  it("rejects an implementation that fails its declared example, and persists nothing", async () => {
    const workdir = await fixture({ "placeholder.txt": "" });
    const source = join(workdir, "mix.ts");
    await writeFile(source, `export default function mix(r) { return { title: "wrong", servings: r.servings }; }\n`, "utf8");
    const implRoot = join(workdir, "impl");

    const result = await runCli(["accept", "mix", RECIPE_SRC, "--source", source, "--impl", implRoot], workdir);

    expect(result.code).toBe(1);
    expect(result.out).toContain("was not accepted");
    // The report is the only record, since nothing is written.
    expect(result.out).toContain("expected");
    expect(result.out).toContain("actual");
  });

  it("names the declared nodes when asked for one that does not exist", async () => {
    const workdir = await fixture({ "placeholder.txt": "" });
    const source = join(workdir, "x.ts");
    await writeFile(source, `export default function x() { return {}; }\n`, "utf8");

    const result = await runCli(
      ["accept", "nosuchnode", RECIPE_SRC, "--source", source, "--impl", join(workdir, "impl")],
      workdir,
    );

    expect(result.code).toBe(1);
    expect(result.out).toContain('no node named "nosuchnode"');
    expect(result.out).toContain("declared:");
  });
});
