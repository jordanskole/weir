export default function totalByMukey(coll) {
  const acc = {};
  for (const seg of Object.values(coll) as any[]) {
    acc[seg.mukey] = (acc[seg.mukey] ?? 0) + seg.acres;
  }
  const mukeys = Object.keys(acc).sort();
  const byMukey = {};
  let total = 0;
  for (const k of mukeys) {
    const a = Math.round(acc[k] * 1e6) / 1e6;
    byMukey[k] = { mukey: k, acres: a };
    total += a;
  }
  return {
    mukeyList: mukeys.join(","),
    totalAcres: Math.round(total * 1e6) / 1e6,
    byMukey,
  };
}
