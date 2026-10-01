// GENERATED from ProxiedCountyQuery.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Proxied County Query */
export const ProxiedCountyQuery = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel identification number being queried"),
  "county": z.enum(["Iosco", "Otsego"]).describe("The county whose FeatureServer sits behind the proxy"),
  "endpoint": z.string().min(10).max(500).describe("The county FeatureServer URL, which is embedded as a proxy parameter"),
  "proxyHost": z.enum(["app.fetchgis.com"]).describe("The third party the query actually goes to"),
  "referer": z.string().min(10).max(200).describe("The Referer header the proxy requires. blue-ribbon spoofs this to `https://app.fetchgis.com/?currentMap=iosco`. Carried as data rather than buried in the fetch implementation, because it is the closest thing this pipeline has to a credential and it should be visible."),
});
export type ProxiedCountyQuery = z.infer<typeof ProxiedCountyQuery>;
