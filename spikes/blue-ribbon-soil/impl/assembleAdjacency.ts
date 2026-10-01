export default function assembleAdjacency(p) {
  const s = p.SoilSummary;
  return {
    dryAcres: s.dryAcres,
    wetAcres: s.wetAcres,
    dominantSeries: s.dominantSeries,
    dwellingRating: p.DwellingRating.rating,
  };
}
