/**
 * Drift, and forking a run to act on it
 * (docs/superpowers/specs/2026-09-29-drift-and-fork.md).
 *
 * Two things under test. **Stripping** makes an edge the complete description
 * of what crosses a wire rather than a lower bound — before this, a field
 * nobody declared rode through into the durable log, which made classification
 * unsound on every typed edge. **Forking** re-executes a recorded run under the
 * current declarations into a *new* run, so the log is never mutated.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const EDGE_REQ = `label: Req\ndescription: d\nfields:\n  pin: { type: utf8, label: P, description: d, nullable: false }\n`;
const parcelEdge = (extra = "") =>
  `label: Parcel\ndescription: d\nfields:\n` +
  `  pin: { type: utf8, label: P, description: d, nullable: false }\n` +
  `  acres: { type: f64, label: A, description: d, nullable: false }\n` +
  extra;

/** A program whose only node is an effect, which is the shape drift arrives in. */
async function fixture(handler: string, parcel = parcelEdge()): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-fork-"));
  const files: Record<string, string> = {
    "edges/Req.edge": EDGE_REQ,
    "edges/Parcel.edge": parcel,
    "nodes/fetch.node": `label: Fetch\ndescription: d\neffect: http\ninput: Req\noutput: Parcel\n`,
    "topology/main.topology": `input: Req\noutput: Parcel\nterminals:\n  - fetch\nwiring:\n  fetch: {}\n`,
    "effects.ts": handler,
    "payload.json": JSON.stringify({ pin: "x" }),
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await mkdir(join(dir, "impl"), { recursive: true });
  return dir;
}

const run = (root: string, id: string, extra: string[] = []) =>
  runCli([
    "run", root, "--impl", join(root, "impl"), "--payload", join(root, "payload.json"),
    "--effects", join(root, "effects.ts"), "--run", id,
    "--log", join(root, "log.jsonl"), "--trace", join(root, "trace.jsonl"), ...extra,
  ]);

async function rows(root: string, correlationId?: string) {
  const text = await readFile(join(root, "log.jsonl"), "utf8");
  const all = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  return correlationId === undefined ? all : all.filter((r) => r.correlationId === correlationId);
}

describe("drift — an edge is the complete description, not a lower bound", () => {
  /**
   * **Spec Testing #1.** `assertPayload` iterated the *declared* fields and
   * returned the payload unchanged, so anything else rode into the durable log.
   *
   * Break-proof, and it is the hazard the spec named: returning `record`
   * instead of `stripped` from `assertPayload` — a strip whose value the caller
   * discards — puts `surprise` back in the logged payload and reddens this,
   * while every other test in the suite still passes. That is why the strip
   * lives in `logOutput`, the one place every instance reaches the log, rather
   * than at the assertion sites: a pure node's output is never asserted at all.
   */
  it("does not let an undeclared field reach the log", async () => {
    const root = await fixture(
      `export default { http: async (p) => ({ ...p, acres: 3.5, surprise: "new upstream field" }) };\n`,
    );

    expect((await run(root, "p1")).code).toBe(0);

    const parcel = (await rows(root, "p1")).find((r) => r.edge === "Parcel")!;
    expect(parcel.payload).toEqual({ pin: "x", acres: 3.5 });
  });

  /** Spec Testing #3: the names reach the envelope, and only when something drifted. */
  it("records the undeclared names on the envelope, and nothing when clean", async () => {
    const drifting = await fixture(
      `export default { http: async (p) => ({ ...p, acres: 3.5, surprise: "s" }) };\n`,
    );
    await run(drifting, "p1");
    const drifted = (await rows(drifting, "p1")).find((r) => r.edge === "Parcel")!;
    expect(drifted.envelope.undeclared).toEqual(["Parcel.surprise"]);

    await rm(drifting, { recursive: true, force: true });

    const clean = await fixture(`export default { http: async (p) => ({ ...p, acres: 3.5 }) };\n`);
    await run(clean, "p2");
    const ok = (await rows(clean, "p2")).find((r) => r.edge === "Parcel")!;
    expect(ok.envelope.undeclared).toBeUndefined();
  });

  /**
   * **Spec Testing #13 — the case §3 originally got wrong.** The spec claimed
   * the values "survive without being copied anywhere new" because the trace
   * records them. True only on the passing path: when an assertion *fails* the
   * trace's `result` was the `Failed_X` payload, and the shape the handler
   * actually returned was recorded nowhere at all.
   *
   * That breaks fork for exactly the run most worth forking, which is why this
   * is the load-bearing assertion of the whole feature.
   *
   * Break-proof: reverting `trace?.record` to pass `result` rather than the
   * captured raw value records `{ input, reason }` here and reddens this.
   */
  it("keeps the raw result in the trace when the assertion fails", async () => {
    const root = await fixture(
      `export default { http: async (p) => ({ ...p, acres: "three point five", surprise: "s" }) };\n`,
    );

    expect((await run(root, "d1")).code).toBe(1);

    // The log holds the failure, as it should.
    const logged = await rows(root, "d1");
    expect(logged.some((r) => r.edge === "Failed_Req")).toBe(true);

    // The trace holds what the world actually said.
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(trace[0].result).toEqual({ pin: "x", acres: "three point five", surprise: "s" });
  });
});

describe("fork — a new run, under current declarations", () => {
  /**
   * **The whole loop: detect, widen, fork.** And the two properties that make
   * an agent loop over candidate schemas viable — the fork supplies **no**
   * `--effects` and needs no credentials, and the parent run is untouched.
   *
   * Break-proof: dropping `effects: plan.effects` from `fork`'s `runNetlist`
   * call fails the run outright with "No handler for effect(s)", since nothing
   * else supplies one — which is the point.
   */
  it("re-runs a recorded run against a widened edge, without handlers, leaving the parent alone", async () => {
    const root = await fixture(
      `export default { http: async (p) => ({ ...p, acres: 3.5, surprise: "new upstream field" }) };\n`,
    );
    await run(root, "p1");
    const parentBefore = await rows(root, "p1");

    // An agent declares the field the drift record named.
    await writeFile(
      join(root, "edges/Parcel.edge"),
      parcelEdge(`  surprise: { type: utf8, label: S, description: d, nullable: false }\n`),
      "utf8",
    );

    const result = await runCli([
      "fork", root, "--impl", join(root, "impl"), "--from", "p1",
      "--trace", join(root, "trace.jsonl"), "--log", join(root, "log.jsonl"), "--run", "p1-fork",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("answered from the recording, 0 performed");

    // The widened declaration now accepts what the server actually sent.
    const forked = await rows(root, "p1-fork");
    expect(forked.find((r) => r.edge === "Parcel")!.payload).toEqual({
      pin: "x",
      acres: 3.5,
      surprise: "new upstream field",
    });
    // Cross-run ancestry is explicit.
    expect(forked.find((r) => r.edge === "Run")!.payload.forkedFrom).toBe("p1");
    // And the log was never mutated.
    expect(await rows(root, "p1")).toEqual(parentBefore);
  });

  /**
   * **Spec Testing #14 — schema discovery, which is the larger claim.**
   *
   * Additive drift is the easy case. *Discovery* — not having the field names
   * yet — and *truncation* both make a **declared** field missing, so the
   * assertion fails and the drift record is never reached. Those are the cases
   * a real integration starts in.
   *
   * With the raw result recorded on the failing path, the loop becomes: run
   * once against the live server, then fork offline against candidate schemas
   * until one validates. No second request, no credentials, and the server's
   * actual bytes as the fixture.
   */
  it("forks a run that FAILED assertion, against a corrected declaration", async () => {
    const root = await fixture(
      `export default { http: async (p) => ({ ...p, acres: "three point five", surprise: "s" }) };\n`,
    );
    expect((await run(root, "d1")).code).toBe(1);

    // The agent reads the trace, sees the real shape, and corrects the type.
    await writeFile(
      join(root, "edges/Parcel.edge"),
      `label: Parcel\ndescription: d\nfields:\n` +
        `  pin: { type: utf8, label: P, description: d, nullable: false }\n` +
        `  acres: { type: utf8, label: A, description: as the server actually sends it, nullable: false }\n` +
        `  surprise: { type: utf8, label: S, description: d, nullable: false }\n`,
      "utf8",
    );

    const result = await runCli([
      "fork", root, "--impl", join(root, "impl"), "--from", "d1",
      "--trace", join(root, "trace.jsonl"), "--log", join(root, "log.jsonl"), "--run", "d1-fork",
    ]);

    expect(result.code).toBe(0);
    const forked = await rows(root, "d1-fork");
    expect(forked.find((r) => r.edge === "Parcel")!.payload).toEqual({
      pin: "x",
      acres: "three point five",
      surprise: "s",
    });
    // The failed parent still records what happened. Nothing was rewritten.
    expect((await rows(root, "d1")).some((r) => r.edge === "Failed_Req")).toBe(true);
  });

  /**
   * **Spec Testing #10, and the sequence is the point.** Widening an edge moves
   * the contract hash of every node naming it, and an implementation resolves
   * *by* contract hash — so the moment after a widening, those nodes have no
   * accepted implementation and the fork is blocked until they are re-accepted.
   *
   * That is the acceptance gate working, not a defect, which is why it has to
   * be reported as work to do rather than as an opaque failure. The real loop
   * is therefore detect → widen → **re-accept downstream** → fork.
   *
   * A first version of this test built a program whose node was never
   * implemented at all, and got "no recorded invocations" instead: an
   * unimplemented node stops `weir run` before anything executes, so there was
   * no trace to fork from. The blocked case only arises for a node that *was*
   * implemented and whose contract then moved.
   */
  it("reports nodes blocked because a widened edge moved their contract", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-fork-"));
    const root = dir;
    const files: Record<string, string> = {
      "edges/Req.edge": EDGE_REQ,
      "edges/Parcel.edge": parcelEdge(),
      "edges/Out.edge": `label: Out\ndescription: d\nfields:\n  pin: { type: utf8, label: P, description: d, nullable: false }\n`,
      "nodes/fetch.node": `label: Fetch\ndescription: d\neffect: http\ninput: Req\noutput: Parcel\n`,
      "nodes/shape.node":
        `label: Shape\ndescription: d\ninput: Parcel\noutput: Out\n` +
        `examples:\n  - given: { Parcel: { pin: "x", acres: 1 } }\n    expect: { Out: { pin: "x" } }\n`,
      "topology/main.topology": `input: Req\noutput: Out\nterminals:\n  - shape\nwiring:\n  fetch:\n    then:\n      shape: {}\n`,
      "effects.ts": `export default { http: async (p) => ({ ...p, acres: 3.5 }) };\n`,
      "payload.json": JSON.stringify({ pin: "x" }),
      "shape-impl.ts": `export default (parcel) => ({ pin: parcel.pin });\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    await mkdir(join(root, "impl"), { recursive: true });

    // Accepted against the contract as it stands, then run to produce a trace.
    const accepted = await runCli([
      "accept", "shape", root, "--source", join(root, "shape-impl.ts"), "--impl", join(root, "impl"),
    ]);
    expect(accepted.code).toBe(0);
    expect((await run(root, "b1")).code).toBe(0);

    // Now widen `Parcel` — which moves `shape`'s contract hash, because `shape`
    // names it as input.
    await writeFile(
      join(root, "edges/Parcel.edge"),
      parcelEdge(`  surprise: { type: utf8, label: S, description: d, nullable: false }\n`),
      "utf8",
    );

    const result = await runCli([
      "fork", root, "--impl", join(root, "impl"), "--from", "b1",
      "--trace", join(root, "trace.jsonl"), "--log", join(root, "log.jsonl"), "--run", "b1-fork",
    ]);

    expect(result.code).toBe(1);
    expect(result.out).toContain("need an accepted implementation");
    expect(result.out).toContain("shape");
  });

  it("refuses a run id with no recorded invocations", async () => {
    const root = await fixture(`export default { http: async (p) => ({ ...p, acres: 3.5 }) };\n`);
    await run(root, "p1");

    const result = await runCli([
      "fork", root, "--impl", join(root, "impl"), "--from", "nope",
      "--trace", join(root, "trace.jsonl"), "--log", join(root, "log.jsonl"),
    ]);

    expect(result.code).toBe(1);
    expect(result.out).toContain("no recorded invocations");
  });
});

describe("replay — the drift refusal reaches effect nodes too", () => {
  /**
   * **Spec Testing #12.** `replay`'s contract-drift refusal sat *below* the
   * effect short-circuit, so it was unreachable for an effect node: replaying
   * one under a changed contract succeeded silently, handing back a recording
   * of something the current declaration no longer describes.
   *
   * Found while building fork, because fork's entire subject is a changed
   * contract. The two commands take opposite stances on it — replay refuses,
   * fork proceeds — which is why they are two commands and not one with a flag.
   *
   * Break-proof: moving the effect short-circuit back above the hash check
   * makes this replay succeed, which is the bug.
   */
  it("refuses to replay an effect node whose contract has changed", async () => {
    const root = await fixture(`export default { http: async (p) => ({ ...p, acres: 3.5 }) };\n`);
    await run(root, "r1");

    // Widen the effect node's own output edge: its contract hash moves.
    await writeFile(
      join(root, "edges/Parcel.edge"),
      parcelEdge(`  surprise: { type: utf8, label: S, description: d, nullable: false }\n`),
      "utf8",
    );

    const result = await runCli([
      "replay", root, "--impl", join(root, "impl"), "--run", "r1", "--trace", join(root, "trace.jsonl"),
    ]);

    expect(result.out).toContain("the declaration supplied hashes to");
    expect(result.out).toContain("✗ fetch");
  });

  /**
   * Noticed while writing the test above, and left alone deliberately: `weir
   * replay` catches each invocation's error, prints it as `✗ <node> <reason>`,
   * and **still exits 0** — so a replay in which every single invocation
   * refused reports success to a caller reading the exit code.
   *
   * Not fixed here because it is pre-existing and outside this spec's subject,
   * and changing it would change what `replay` means to anything scripting it.
   * Pinned so the behaviour is deliberate rather than assumed, and recorded in
   * `docs/open-questions/`.
   */
  it("exits zero even when every invocation refused — pinned, not endorsed", async () => {
    const root = await fixture(`export default { http: async (p) => ({ ...p, acres: 3.5 }) };\n`);
    await run(root, "r2");
    await writeFile(
      join(root, "edges/Parcel.edge"),
      parcelEdge(`  surprise: { type: utf8, label: S, description: d, nullable: false }\n`),
      "utf8",
    );

    const result = await runCli([
      "replay", root, "--impl", join(root, "impl"), "--run", "r2", "--trace", join(root, "trace.jsonl"),
    ]);

    expect(result.out).toContain("✗");
    expect(result.code).toBe(0);
  });
});
