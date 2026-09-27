import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

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

const EDGE = (name: string) => `description: ${name}\nfields:\n  v:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`;

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

  it("check: reports a wiring failure as a message, with a non-zero code and no stack trace", async () => {
    // The errors are the product — this is the assertion that matters.
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/makeA.node": `label: MA\ndescription: d\ninput: A\noutput: A\n`,
      "nodes/needsB.node": `label: NB\ndescription: d\ninput: B\noutput: B\n`,
      "topology/main.topology": `makeA:\n  then:\n    needsB: {}\n`,
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
      "nodes/makeA.node": `label: MA\ndescription: d\ninput: A\noutput: A\n`,
      "nodes/join.node": `label: J\ndescription: d\ninput:\n  allOf:\n    - A\n    - B\noutput: B\n`,
      "topology/main.topology": `makeA:\n  then:\n    join: {}\n`,
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
    await writeFile(payload, JSON.stringify({ mix: recipe, preheatOven: recipe }), "utf8");
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
    await writeFile(payload, JSON.stringify({ mix: {} }), "utf8");

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
      "edges/Reading.edge": `description: R\nfields:\n  value:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`,
      "nodes/observe.node": `label: O\ndescription: d\ninput: Reading\noutput: Reading\n`,
      "topology/main.topology": `observe: {}\n`,
    });
    const { hashNode } = await import("./hash.js");
    const { elaborate } = await import("./elaborate.js");
    const hash = (await hashNode((await elaborate(workdir)).nodes.observe!)).short;
    const implRoot = join(workdir, "impl");
    await mkdir(join(implRoot, "observe"), { recursive: true });
    await writeFile(join(implRoot, "observe", `${hash}.ts`), `${fn}\n`, "utf8");
    const payload = join(workdir, "payload.json");
    await writeFile(payload, JSON.stringify({ observe: { value: "x" } }), "utf8");

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

  it("fails a node that reads a clock, and does not accuse it of the wrong cause", async () => {
    const { verify } = await runThenVerify(
      `export default function observe(r) { return { value: r.value + process.hrtime.bigint().toString() }; }`,
    );

    expect(verify.code).toBe(1);
    expect(verify.out).toContain("did not replay identically");
    expect(verify.out).toContain("recorded");
    expect(verify.out).toContain("replayed");
    // A mismatch has two possible causes while the pin is contract-shaped.
    expect(verify.out).toContain("the version pin pins the");
  });
});
