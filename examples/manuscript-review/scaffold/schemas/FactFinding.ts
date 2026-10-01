// GENERATED from FactFinding.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Fact Finding */
export const FactFinding = z.object({
  "revision_id": z.string().min(1).max(100).describe("The revision this finding is about"),
  "claim": z.string().min(1).max(500).describe("The claim that was checked"),
  "round": z.number().int().min(0).max(255).min(1).max(10).describe("Which review round this finding is from, carried through from the revision"),
});
export type FactFinding = z.infer<typeof FactFinding>;
