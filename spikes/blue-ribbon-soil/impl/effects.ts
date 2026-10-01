/** One `http` handler standing in for three different USDA SDA queries. It
 * dispatches on the payload's shape, because `effect: http` names a TRANSPORT
 * and not a counterparty -- the same observation as the first slice. */
export default {
  http: async (payload: any) => {
    // 1. The server-side clip. Two map units, one of which has two disjoint
    //    segments -- which is why polygonId exists and mukey is not the key.
    if (payload.wkt !== undefined) {
      return {
        "sp-1": { polygonId: "sp-1", mukey: "162341",
          wkt: "POLYGON((-85.3 44,-85.3 44.001,-85.299 44.001,-85.299 44,-85.3 44))" },
        "sp-2": { polygonId: "sp-2", mukey: "162355",
          wkt: "POLYGON((-85.299 44,-85.299 44.002,-85.298 44.002,-85.298 44,-85.299 44))" },
      };
    }
    // 2. Dominant component per map unit.
    if (payload.mukeyList !== undefined) {
      return {
        "162341": { mukey: "162341", cokey: "21012345", compname: "Kalkaska",
          comppctR: 85, drainagecl: "Somewhat excessively drained", wtdepannmin: null },
        "162355": { mukey: "162355", cokey: "21012399", compname: "Au Gres",
          comppctR: 90, drainagecl: "Somewhat poorly drained", wtdepannmin: 15 },
      };
    }
    // 3. The dwelling interpretation.
    return { cokey: payload.cokey, rating: "Somewhat limited" };
  },
};
