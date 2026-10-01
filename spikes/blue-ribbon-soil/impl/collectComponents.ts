export default function collectComponents(coll) {
  const byMukey = {};
  for (const c of Object.values(coll) as any[]) byMukey[c.mukey] = c;
  return { componentCount: Object.keys(byMukey).length, byMukey };
}
