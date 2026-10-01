// GENERATED from ParcelRequest.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Parcel Request */
export const ParcelRequest = z.object({
  "pin": z.string().min(8).max(40).describe("The county parcel identification number, canonical dash-separated form. Segment count and width are a county convention, not a fixed shape -- \"10-003-013-20\" (Osceola) and \"062-026-300-020-00\" (Iosco) are both valid."),
  "county": z.enum(["Osceola", "Manistee", "Roscommon", "Iosco", "Otsego"]).describe("Which Michigan county's adapter resolves this PIN"),
});
export type ParcelRequest = z.infer<typeof ParcelRequest>;
