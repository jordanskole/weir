// blue-ribbon's A2 rule, derive.ts:11 -- drainage class in the dry set AND no
// water table anywhere in the profile.
const DRY = new Set([
  "Somewhat excessively drained",
  "Excessively drained",
  "Well drained",
]);
const isDry = (c) => c !== undefined && c.drainagecl !== null && DRY.has(c.drainagecl) && c.wtdepannmin === null;

export default function summarizeSoil(p) {
  const totals = p.SoilAreaTotals;
  const comps = p.ComponentSet.byMukey;
  let dry = 0, wet = 0;
  let dominant = null;
  for (const { mukey, acres } of Object.values(totals.byMukey) as any[]) {
    const c = comps[mukey];
    if (isDry(c)) {
      dry += acres;
      if (dominant === null || acres > dominant.acres) {
        dominant = { mukey, cokey: c.cokey, series: c.compname, acres };
      }
    } else {
      // A map unit with NO component at all counts as wet, not as missing --
      // blue-ribbon's else branch, and the reason wetAcres is "everything else".
      wet += acres;
    }
  }
  return {
    dryAcres: Math.round(dry * 1e6) / 1e6,
    wetAcres: Math.round(wet * 1e6) / 1e6,
    dominantMukey: dominant === null ? null : dominant.mukey,
    dominantCokey: dominant === null ? null : dominant.cokey,
    dominantSeries: dominant === null ? null : dominant.series,
  };
}
