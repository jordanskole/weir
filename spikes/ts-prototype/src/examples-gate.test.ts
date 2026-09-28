/**
 * Examples reach the gate
 * (docs/superpowers/specs/2026-09-28-examples-reach-the-gate.md).
 *
 * A `.node` file tags its examples by edge name; a `NodeDef`'s examples hold
 * what `Fn` is actually called with and returns. Nothing translated between
 * them, so `acceptImplementation` asserted `{Recipe: …}` against the `Recipe`
 * schema, it failed, and **every example in `examples/` failed its own
 * acceptance gate** — validated for shape by `nodeSchema()` and never run.
 *
 * Two kinds of test here, deliberately:
 *
 * - **One real trip through the gate** (`mix`), which is the motivating case and
 *   the narrowest proof that the fix works end to end.
 * - **A corpus check over every node in every example**, which needs no
 *   implementations and so scales as examples are added. It asserts each
 *   declared example is well-formed against its own contract — which is exactly
 *   what the gate checks first, and exactly what was broken.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptImplementation } from "./accept.js";
import { elaborate } from "./elaborate.js";
import { assertOutput, assertPayload } from "./membrane.js";
import type { InputSpec, NodeDecl } from "./types.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Asserts a `given` against the shape its node's input declares — the check the
 * membrane performs before calling `Fn`, without needing an `Fn` to call.
 * `assertOutput` (membrane.ts) is its counterpart for `expect` and already
 * takes exactly the post-translation runtime form, which is a useful
 * confirmation that the translation targets the right shapes.
 */
function assertInput(input: InputSpec, given: unknown): void {
  if (input.kind === "single") {
    assertPayload(input.edge, given);
    return;
  }
  if (input.kind === "gather") {
    for (const entry of Object.values((given ?? {}) as Record<string, unknown>)) {
      assertPayload(input.edge, entry);
    }
    return;
  }
  const bag = (given ?? {}) as Record<string, unknown>;
  for (const edge of input.edges) assertPayload(edge, bag[edge.name]);
}

describe("examples reach the gate", () => {
  /**
   * The motivating case, run end to end. Before the fix this returned
   * `accepted: false` with an `exampleFailures` entry whose `actual` was
   * `Failed<In>` — a *correct* implementation rejected because its example was
   * handed to it still wrapped in its edge-name tag.
   *
   * Break-proof: reverting `untagExamples` to pass `examples` through unchanged
   * reddens this immediately, which is the whole point — the test is the defect
   * stated as an assertion.
   */
  it("accepts a correct implementation of a real example node", async () => {
    const { nodes } = await elaborate(join(EXAMPLES, "recipe/src"));
    const dir = await mkdtemp(join(tmpdir(), "weir-gate-"));
    dirs.push(dir);

    const result = await acceptImplementation(
      nodes.mix!,
      `export default function mix(r) { return { title: r.title, servings: r.servings }; }\n`,
      dir,
      { count: 20 },
    );

    expect(result.accepted).toBe(true);
  });

  /**
   * The guard against fixing the gate by loosening it. An implementation that
   * genuinely disagrees with the declared example must still be rejected, and
   * the rejection must carry what was expected against what came back.
   */
  it("still rejects an implementation that disagrees with the declared example", async () => {
    const { nodes } = await elaborate(join(EXAMPLES, "recipe/src"));
    const dir = await mkdtemp(join(tmpdir(), "weir-gate-"));
    dirs.push(dir);

    const result = await acceptImplementation(
      nodes.mix!,
      `export default function mix(r) { return { title: "wrong", servings: r.servings }; }\n`,
      dir,
      { count: 20 },
    );

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures).toHaveLength(1);
    expect(result.exampleFailures[0]!.expected).toEqual({ title: "Chocolate Chip Cookies", servings: 24 });
    expect(result.exampleFailures[0]!.actual).toEqual({ title: "wrong", servings: 24 });
    // Nothing persisted, which is the accept-before-persist rule.
    expect(await readdir(dir)).toEqual([]);
  });

  /**
   * The corpus check, and the one that scales. Every declared example in every
   * example program must be well-formed against its own node's contract: the
   * `given` is a valid input, the `expect` is a valid output.
   *
   * This is what would have caught the bug — before the fix, *every* `given`
   * here failed, because each was still wrapped in its edge-name tag.
   *
   * Break-proof: reverting `untagExamples` reddens this for every node in every
   * example at once, which is a fair description of what the defect was.
   */
  it("every declared example in every example program is well-formed against its own contract", async () => {
    const roots = (await readdir(EXAMPLES, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    // Guard against the check examining nothing if the layout moves.
    expect(roots.length).toBeGreaterThan(4);

    const failures: string[] = [];
    let checked = 0;
    for (const example of roots) {
      const { nodes } = await elaborate(join(EXAMPLES, example, "src"));
      for (const [name, node] of Object.entries(nodes as Record<string, NodeDecl>)) {
        for (const [i, declared] of (node.examples ?? []).entries()) {
          checked += 1;
          try {
            assertInput(node.input, declared.given);
          } catch (cause) {
            failures.push(`${example}/${name} example ${i} given: ${(cause as Error).message}`);
          }
          try {
            assertOutput(node.output, declared.expect);
          } catch (cause) {
            failures.push(`${example}/${name} example ${i} expect: ${(cause as Error).message}`);
          }
        }
      }
    }

    // A second guard on the same failure mode as above: if examples ever stop
    // being parsed into `NodeDecl`, this loop would pass by examining nothing.
    expect(checked).toBeGreaterThan(15);
    expect(failures).toEqual([]);
  });
});
