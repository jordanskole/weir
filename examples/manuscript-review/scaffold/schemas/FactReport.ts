// GENERATED from FactReport.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** FactReport */
export const FactReport = z.object({
  "revision_id": z.string().min(1).max(100).describe("The revision this report is about"),
  "note": z.string().min(1).max(500).describe("What the fact check found"),
});
export type FactReport = z.infer<typeof FactReport>;
