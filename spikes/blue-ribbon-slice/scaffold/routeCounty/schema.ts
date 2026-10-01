// GENERATED from the declarations by `weir emit-zod routeCounty` — do not edit.
// Re-run the emitter instead; this file is mechanical output.

import { z } from "zod";

/** Parcel Request */
export const ParcelRequest = z.object({
  "pin": z.string().min(8).max(40).describe("The county parcel identification number, canonical dash-separated form. Segment count and width are a county convention, not a fixed shape -- \"10-003-013-20\" (Osceola) and \"062-026-300-020-00\" (Iosco) are both valid."),
  "county": z.enum(["Osceola", "Manistee", "Roscommon", "Iosco", "Otsego"]).describe("Which Michigan county's adapter resolves this PIN"),
});
export type ParcelRequest = z.infer<typeof ParcelRequest>;

/** Direct County Query */
export const DirectCountyQuery = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel identification number being queried"),
  "county": z.enum(["Osceola", "Manistee", "Roscommon"]).describe("The county whose FeatureServer is being queried"),
  "endpoint": z.string().min(10).max(500).describe("The county FeatureServer query URL. Verified-provenance source: the county is the authoritative publisher of its own parcel geometry."),
});
export type DirectCountyQuery = z.infer<typeof DirectCountyQuery>;

/** Proxied County Query */
export const ProxiedCountyQuery = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel identification number being queried"),
  "county": z.enum(["Iosco", "Otsego"]).describe("The county whose FeatureServer sits behind the proxy"),
  "endpoint": z.string().min(10).max(500).describe("The county FeatureServer URL, which is embedded as a proxy parameter"),
  "proxyHost": z.enum(["app.fetchgis.com"]).describe("The third party the query actually goes to"),
  "referer": z.string().min(10).max(200).describe("The Referer header the proxy requires. blue-ribbon spoofs this to `https://app.fetchgis.com/?currentMap=iosco`. Carried as data rather than buried in the fetch implementation, because it is the closest thing this pipeline has to a credential and it should be visible."),
});
export type ProxiedCountyQuery = z.infer<typeof ProxiedCountyQuery>;

/** What `routeCounty` receives, after the membrane has asserted it. */
export const routeCountyInput = ParcelRequest;
export type routeCountyInput = z.infer<typeof routeCountyInput>;

/** What `routeCounty` must return. Throw to decline. */
export const routeCountyOutput = z.discriminatedUnion("edge", [
  z.object({ edge: z.literal("DirectCountyQuery"), payload: DirectCountyQuery }),
  z.object({ edge: z.literal("ProxiedCountyQuery"), payload: ProxiedCountyQuery }),
]);
export type routeCountyOutput = z.infer<typeof routeCountyOutput>;

export type routeCountyFn = (p: routeCountyInput) => routeCountyOutput;
