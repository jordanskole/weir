const r6 = (n) => Math.round(n * 1e6) / 1e6;
export default function buildSoilQuery(p) {
  const ring = Object.values(p.rings).find((r: any) => r.seq === 0) as any;
  const vs = Object.values(ring.vertices).sort((a: any, b: any) => a.seq - b.seq) as any[];
  const pts = vs.map((v) => `${v.lng} ${v.lat}`).join(",");
  return { pin: p.pin, wkt: `POLYGON((${pts}))` };
}
