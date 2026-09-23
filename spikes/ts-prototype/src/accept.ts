// spikes/ts-prototype/src/accept.ts
/**
 * The accept-before-persist gate (docs/design.md §10; docs/superpowers/
 * specs/2026-09-10-acceptance-pipeline.md) — the write half of the
 * implementation seam whose read half (`implementation.ts`'s
 * `resolveImplementation`) has existed since build-order step 3.
 *
 * A candidate arrives as source text — what an isolated agent's draft
 * actually is, and what `computeImplementationMetadata` already consumes —
 * gets loaded, run against the node's own declared examples and against
 * generated cases, and is persisted to `{node-name}/<contract-hash>.ts`
 * only if everything passes. A draft that fails anything leaves nothing
 * behind: drafts aren't versions and don't live in the implementation tree
 * (§10).
 *
 * What this deliberately does *not* check: real semantic correctness
 * beyond what the declared examples pin down exactly. §6's property
 * assertions (`∀ p . ...`) have no representation in `types.ts` yet; a
 * candidate can pass every example and every structural check here and
 * still be wrong in a way nothing declared would catch. Named limitation,
 * not an oversight.
 */

import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fuzzNode } from "./fuzz.js";
import type { FuzzReport } from "./fuzz.js";
import { hashNode } from "./hash.js";
import { invokeWithInput } from "./invoke.js";
import { computeImplementationMetadata } from "./metadata.js";
import type { NodeDecl, NodeDef } from "./types.js";

export interface ExampleFailure {
  given: unknown;
  expected: unknown;
  actual: unknown;
}

export type AcceptanceResult =
  | { accepted: true; path: string; metadataPath: string }
  | { accepted: false; reason: "load-failed"; error: string }
  | {
      accepted: false;
      reason: "checks-failed";
      exampleFailures: ExampleFailure[];
      fuzzReport: FuzzReport;
    };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs every declared example through the same membrane seam generated
 * cases go through. An example that resolves to `Failed<In>` needs no
 * special case: that shape simply won't deep-equal the declared
 * `OutputResult<O>`, so it lands in `failures` like any other mismatch.
 */
async function checkExamples(nodeDef: NodeDef): Promise<ExampleFailure[]> {
  const failures: ExampleFailure[] = [];
  for (const [i, example] of (nodeDef.examples ?? []).entries()) {
    const actual = await invokeWithInput(nodeDef, example.given, `accept-example-${i}`);
    if (!isDeepStrictEqual(actual, example.expect)) {
      failures.push({ given: example.given, expected: example.expect, actual });
    }
  }
  return failures;
}

export async function acceptImplementation(
  nodeDecl: NodeDecl,
  source: string,
  implRoot: string,
  opts?: { seed?: number; count?: number },
): Promise<AcceptanceResult> {
  const { short } = await hashNode(nodeDecl);
  const nodeDir = join(implRoot, nodeDecl.name);
  const path = join(nodeDir, `${short}.ts`);

  if (await exists(path)) {
    throw new Error(
      `"${nodeDecl.name}" already has an accepted implementation at contract hash "${short}" ` +
        `(${path}). An accepted implementation is never overwritten (docs/design.md §10) — a new ` +
        `one is written only when the contract's own hash changes.`,
    );
  }

  // A fresh directory per call: dynamic import() caches by URL, so a fixed
  // draft path would silently re-run the first candidate's code forever.
  const draftDir = await mkdtemp(join(tmpdir(), "weir-accept-"));
  try {
    const draftPath = join(draftDir, `${short}.ts`);
    await writeFile(draftPath, source, "utf8");

    let fn: NodeDef["fn"];
    try {
      const mod = (await import(pathToFileURL(draftPath).href)) as Record<string, unknown>;
      if (typeof mod.default !== "function") {
        return { accepted: false, reason: "load-failed", error: "the candidate must default-export the node's Fn." };
      }
      fn = mod.default as NodeDef["fn"];
    } catch (cause) {
      return { accepted: false, reason: "load-failed", error: (cause as Error).message };
    }

    const nodeDef: NodeDef = { ...nodeDecl, fn };

    // Both always run — a caller iterating toward acceptance sees every gap
    // at once, the same "collect everything" idiom assertPayload already uses.
    // fuzzNode's own throws (a generator defect, a `many` output with no
    // index) are declaration/generator problems rather than verdicts on this
    // candidate, so they propagate rather than becoming a rejection.
    const exampleFailures = await checkExamples(nodeDef);
    const fuzzReport = await fuzzNode(nodeDef, opts);

    if (exampleFailures.length > 0 || fuzzReport.failures.length > 0) {
      return { accepted: false, reason: "checks-failed", exampleFailures, fuzzReport };
    }

    await mkdir(nodeDir, { recursive: true });
    // Copy rather than rename: the OS temp dir and implRoot aren't
    // guaranteed to share a filesystem, and a cross-device rename is EXDEV.
    await copyFile(draftPath, path);

    const metadataPath = join(nodeDir, `${short}.meta.json`);
    await writeFile(metadataPath, `${JSON.stringify(computeImplementationMetadata(source), null, 2)}\n`, "utf8");

    return { accepted: true, path, metadataPath };
  } finally {
    await rm(draftDir, { recursive: true, force: true });
  }
}
