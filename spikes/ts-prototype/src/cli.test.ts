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
    // No `run`, deliberately — the only Log is in-memory.
    expect(unknown.out).toContain("no \"run\"");
  });
});
