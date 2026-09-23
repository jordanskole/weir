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
 * Beyond examples and structural shape, a node may also declare §6
 * property assertions (`∀ p . ...`) — invariants that must hold for every
 * generated case whose result was a real output, not a `Failed<In>`. A
 * candidate that only special-cases its declared examples (the motivating
 * failure this closes) passes them exactly and fails a property on the
 * first generated case that isn't the example. A node declaring properties
 * where no generated case produced a real output is rejected as vacuous —
 * every property having passed vacuously is the same false-green shape
 * that has already shipped twice (design-history.md), not a clean result.
 *
 * A fresh draft directory per call sidesteps one gotcha (dynamic `import()`
 * caches by URL, so a fixed draft path would silently re-run the first
 * candidate's code forever) but has a flip side worth naming rather than
 * discovering later: each draft's URL stays registered in the process's ESM
 * module registry for the process's lifetime even after the file behind it
 * is deleted — there's no `import.unregister()`. Irrelevant at spike scale
 * (a handful of calls per test run); real for the agent-iterating-toward-
 * acceptance loop this gate exists to serve, where one long-running process
 * could call this thousands of times.
 */

import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      /**
       * True when the node declares properties but no generated case
       * produced a real output, so every property passed only because
       * there was nothing to check it against. Carried explicitly because
       * a rejection with no failures listed is otherwise unexplainable
       * from the result alone.
       */
      vacuous: boolean;
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

  if ((nodeDecl.examples ?? []).length === 0) {
    throw new Error(
      `"${nodeDecl.name}" declares no examples. A single example can't pin down a function ` +
        `(docs/design.md §6 — one example underdetermines the mapping a node's supposed to compute), ` +
        `and with zero, nothing does: fuzzNode's generated-case check legitimately counts Failed<In> as ` +
        `a pass, so a candidate that fails on every input would sail through unconstrained. ` +
        `"schema.ts"'s nodeSchema() already requires examples to be non-empty at authoring time — this ` +
        `is the same invariant, enforced again here because a candidate is actually checked against it.`,
    );
  }

  if (await exists(path)) {
    throw new Error(
      `"${nodeDecl.name}" already has an accepted implementation at contract hash "${short}" ` +
        `(${path}). An accepted implementation is never overwritten (docs/design.md §10) — a new ` +
        `one is written only when the contract's own hash changes.`,
    );
  }

  // A fresh directory per call: dynamic import() caches by URL, so a fixed
  // draft path would silently re-run the first candidate's code forever.
  // Drafted under implRoot itself, not the OS temp dir — a candidate that
  // imports one of the project's own dependencies must resolve bare
  // specifiers the same way it will once persisted; drafting outside
  // implRoot's own directory tree checks the candidate in a different
  // module-resolution context than it will ever actually run in.
  await mkdir(implRoot, { recursive: true });
  const draftDir = await mkdtemp(join(implRoot, ".drafts-"));
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

    // A node declaring properties none of whose generated cases produced a
    // real output has had every property pass vacuously — the same
    // false-green shape that shipped twice before this (design-history.md).
    const vacuous = (nodeDecl.properties ?? []).length > 0 && fuzzReport.realOutputs === 0;

    if (
      exampleFailures.length > 0 ||
      fuzzReport.failures.length > 0 ||
      fuzzReport.propertyFailures.length > 0 ||
      vacuous
    ) {
      return { accepted: false, reason: "checks-failed", exampleFailures, fuzzReport, vacuous };
    }

    // Computed before anything is written: it's a pure function of `source`
    // and it can throw (a parse-diagnostic candidate — metadata.ts's
    // assertParsed) — if that happens after copyFile instead, an
    // implementation file is left on disk with no metadata sibling, and the
    // already-accepted check above then makes that contract hash permanently
    // un-acceptable (nothing will ever pass `exists(path)` false again for
    // it), recoverable only by hand. Computing first means nothing that can
    // still fail is left to fail after a write has already happened.
    const metadata = computeImplementationMetadata(source);

    await mkdir(nodeDir, { recursive: true });
    // Copy rather than rename: not for cross-device safety anymore — the
    // draft now lives under implRoot itself, so draftPath and path always
    // share a filesystem — but copyFile's COPYFILE_EXCL flag makes the
    // "never overwritten" invariant real rather than advisory, closing the
    // TOCTOU window between the exists() check above and this write (two
    // concurrent calls for the same contract hash could otherwise both see
    // "doesn't exist yet" and the second would clobber the first).
    await copyFile(draftPath, path, constants.COPYFILE_EXCL);

    const metadataPath = join(nodeDir, `${short}.meta.json`);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    return { accepted: true, path, metadataPath };
  } finally {
    await rm(draftDir, { recursive: true, force: true });
  }
}
