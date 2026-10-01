// GENERATED from ParcelCentroid.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Parcel Centroid */
export const ParcelCentroid = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel this point is inside"),
  "lng": z.number().min(-180).max(180).describe("WGS84 longitude of the parcel's area-weighted centroid"),
  "lat": z.number().min(-90).max(90).describe("WGS84 latitude of the parcel's area-weighted centroid"),
});
export type ParcelCentroid = z.infer<typeof ParcelCentroid>;
