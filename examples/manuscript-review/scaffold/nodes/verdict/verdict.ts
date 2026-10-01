import type { verdictInput, verdictOutput } from "./schema.js";

/**
 * verdict — joins one revision's two reports into a note.
 *
 * The lineage join should only ever hand this reports for the same revision. If
 * it didn't, there is no honest note to write about "the" revision, so decline
 * rather than pick a side. (The generator's bags mostly mismatch, so most
 * generated cases decline; the matching ones are what prove it can answer.)
 */
export default function verdict(p: verdictInput): verdictOutput {
  const { StyleReport: style, FactReport: fact } = p;
  if (style.revision_id !== fact.revision_id) {
    throw new Error(
      `verdict: reports are about different revisions (${style.revision_id} vs ${fact.revision_id})`,
    );
  }
  return {
    revision_id: style.revision_id,
    combined: `${style.note} | ${fact.note}`,
  };
}
