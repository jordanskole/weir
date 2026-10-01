import type { confirmCitationsInput, confirmCitationsOutput } from "./schema.js";

/** confirmCitations — second hop of the fact arm; reads the round from its field. */
export default function confirmCitations(p: confirmCitationsInput): confirmCitationsOutput {
  return { revision_id: p.revision_id, note: `facts ok at round ${p.round}` };
}
