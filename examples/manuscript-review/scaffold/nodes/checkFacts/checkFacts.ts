import type { checkFactsInput, checkFactsOutput } from "./schema.js";

/**
 * checkFacts — first hop of the fact arm. The round is carried through as its
 * own field (FactFinding.round) so confirmCitations never has to parse it out of
 * the claim's prose.
 */
export default function checkFacts(p: checkFactsInput): checkFactsOutput {
  return { revision_id: p.id, claim: `claim at round ${p.round}`, round: p.round };
}
