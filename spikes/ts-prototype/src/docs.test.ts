/**
 * Mechanical checks on the prose.
 *
 * The docs make claims about the code, and this repo has now twice found them
 * drifting: `assertWiringTypes`' own header described a `many` rule that spread
 * had deleted a day earlier, and `design.md` §5 asserted a multi-origin fan-in
 * gap that the run root had closed. Almost none of that is mechanically
 * checkable — "is this paragraph still true" needs a reader.
 *
 * Two narrow things are, and both earned their place by catching a real
 * mistake rather than by being tidy:
 *
 * 1. **Every relative link resolves, and stays inside the repo.** Writing the
 *    §10 paragraph about the implementation pin, I cited
 *    `superpowers/specs/2026-09-27-the-implementation-pin.md`, which does not
 *    exist — the pin was built alongside the determinism check without a spec
 *    of its own. A dead link in a doc whose whole job is pointing at evidence
 *    is worse than no link, because it reads as evidence.
 *
 *    The in-repo half was added after this file's own first CI run, which is
 *    the more interesting story: it passed locally and failed on CI, because
 *    `design-history.md` and `getting-started.md` linked `../../bankql` — a
 *    sibling repo that exists on the author's machine and nowhere else. The
 *    local pass was a false green bought by a checkout that happened to be
 *    next door, so existence alone is not the check; a link a reader can
 *    follow is, and only an in-repo target is one.
 * 2. **Every spec marked implemented is reachable from a doc a reader starts
 *    from.** A spec nobody links is a spec nobody finds, and the status line
 *    is exactly the signal that it is worth finding.
 *
 * Deliberately not attempted: checking that prose *claims* match behaviour.
 * That is what the audit passes are for, and pretending a test could do it
 * would be the false green this file exists in reaction to.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The docs a reader is pointed at, which is what makes their links load-bearing. */
const ENTRY_DOCS = [
  "readme.md",
  "docs/design.md",
  "docs/design-history.md",
  "docs/open-questions.md",
  "docs/getting-started.md",
];

/**
 * Markdown inline links only. Skips absolute URLs, `#`-only anchors, and
 * strips any trailing `#fragment` — a fragment naming a heading that moved is
 * a different (and much noisier) check than a path that does not exist.
 */
function relativeLinks(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    found.push(target.split("#")[0]!);
  }
  return found;
}

describe("docs — relative links resolve", () => {
  for (const doc of ENTRY_DOCS) {
    it(`${doc} links all point at something that exists`, async () => {
      const markdown = await readFile(join(REPO, doc), "utf8");
      const base = dirname(join(REPO, doc));
      const broken = relativeLinks(markdown).filter((target) => {
        const full = resolve(base, target);
        // Outside the repo is broken *even when it exists*: it resolves only
        // on a machine that happens to have that directory next door. See
        // this file's header — the check passed locally for exactly that
        // reason before CI caught it.
        if (!full.startsWith(REPO + "/")) return true;
        return !existsSync(full);
      });
      expect(broken).toEqual([]);
    });
  }
});

describe("docs — an implemented spec is findable", () => {
  it("every spec marked `Status: implemented` is linked from at least one entry doc", async () => {
    const specDir = join(REPO, "docs/superpowers/specs");
    const specs = (await readdir(specDir)).filter((name) => name.endsWith(".md"));

    const implemented: string[] = [];
    for (const name of specs) {
      const text = await readFile(join(specDir, name), "utf8");
      // The convention is a `Status:` line near the top; only "implemented"
      // makes a spec something a reader should be able to reach.
      if (/^Status:\s*implemented\.?$/im.test(text)) implemented.push(name);
    }
    // Guard against the check silently examining nothing, which is this
    // repo's most frequent bug: if the status convention ever changes, this
    // fails here rather than passing with an empty list.
    expect(implemented.length).toBeGreaterThan(5);

    const linked = new Set<string>();
    for (const doc of ENTRY_DOCS) {
      const markdown = await readFile(join(REPO, doc), "utf8");
      for (const target of relativeLinks(markdown)) {
        if (target.includes("superpowers/specs/")) linked.add(target.split("/").pop()!);
      }
    }

    expect(implemented.filter((name) => !linked.has(name))).toEqual([]);
  });
});
