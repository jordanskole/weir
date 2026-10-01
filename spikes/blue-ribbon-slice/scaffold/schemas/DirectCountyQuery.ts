// GENERATED from DirectCountyQuery.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Direct County Query */
export const DirectCountyQuery = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel identification number being queried"),
  "county": z.enum(["Osceola", "Manistee", "Roscommon"]).describe("The county whose FeatureServer is being queried"),
  "endpoint": z.string().min(10).max(500).describe("The county FeatureServer query URL. Verified-provenance source: the county is the authoritative publisher of its own parcel geometry."),
});
export type DirectCountyQuery = z.infer<typeof DirectCountyQuery>;
