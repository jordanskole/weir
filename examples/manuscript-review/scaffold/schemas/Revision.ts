// GENERATED from Revision.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Revision */
export const Revision = z.object({
  "id": z.string().min(1).max(100).describe("A stable identifier for this revision, unique within the review"),
  "text": z.string().min(1).max(2000).describe("The manuscript body at this round"),
  "round": z.number().int().min(0).max(255).min(1).max(10).describe("Which review round this is"),
});
export type Revision = z.infer<typeof Revision>;
