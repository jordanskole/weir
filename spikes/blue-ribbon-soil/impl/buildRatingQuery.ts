export default function buildRatingQuery(p) {
  if (p.dominantCokey === null) throw new Error("no dry component to rate");
  return { cokey: p.dominantCokey };
}
