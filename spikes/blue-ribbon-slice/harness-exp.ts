const IMPL = process.env.BRP_IMPL ?? "/tmp/brp-impl";
const LOG = process.env.BRP_LOG ?? "/tmp/brp.jsonl";
const TRACE = process.env.BRP_TRACE ?? "/tmp/brp-trace.jsonl";
const RUN = process.env.BRP_RUN ?? "brp-1";
import { elaborateWithImplementations } from "../ts-prototype/src/implementation.js";
import { runNetlist } from "../ts-prototype/src/runtime.js";
import { FileLog } from "../ts-prototype/src/file-log.js";
import { FileTrace } from "../ts-prototype/src/file-trace.js";

const DIR = "/Users/jordan/code/weir/spikes/blue-ribbon-slice";

const FIXTURES: Record<string, string> = {
  Iosco: JSON.stringify({
    properties: { TaxID: "062-026-300-020-00", Shape_Area: 370701.0 },
    geometry: { type: "Polygon", coordinates: [[[-83.40,44.40],[-83.40,44.50],[-83.30,44.50],[-83.30,44.40],[-83.40,44.40]]] },
  }),
  Osceola: JSON.stringify({
    properties: { PIN: "10 003 013 20", OWNER: "SPRAGUE WILLIAM E", UNIT: "MIDDLE BRANCH TOWNSHIP", Shape__Area: 163567.8 },
    geometry: { type: "Polygon", coordinates: [[[-85.30,44.10],[-85.30,44.20],[-85.20,44.20],[-85.20,44.10],[-85.30,44.10]]] },
  }),
};

const OMIT = process.env.BRP_EXP === "missing";
const effects = {
  http: async (payload: any) => {
    // One handler for every http effect, dispatching on what it was given --
    // which is itself a finding: `effect: http` names a TRANSPORT, not a
    // counterparty, so the host cannot tell the fetchgis proxy from a county
    // FeatureServer without re-deriving it from the payload.
    if (payload.proxyHost !== undefined) {
      if (OMIT) return { county: payload.county, sourceTrust: "aggregator" };
      return { county: payload.county, sourceTrust: "aggregator", featureJson: FIXTURES[payload.county],
        ...(process.env.BRP_EXP === "undeclared" ? { ownerName: "SPRAGUE WILLIAM E", ownerMailing: "8783 River Rd" } : {}) };
    }
    if (payload.endpoint !== undefined) {
      return { county: payload.county, sourceTrust: "verified", featureJson: FIXTURES[payload.county] };
    }
    return {
      pin: payload.pin, township: "Oscoda", provenance: "verified",
      vintageAsOf: "2026-08-30", vintageSourceType: "periodic",
      vintageNote: "statewide MCD point-in-polygon",
    };
  },
};

async function main() {
  const program = await elaborateWithImplementations(DIR, IMPL);
  const log = FileLog.open(LOG);
  const trace = FileTrace.open(TRACE);
  const result = await runNetlist(
    program,
    { correlationId: RUN, originPayloads: { routeCounty: JSON.parse(process.argv[2]) } },
    { log, trace, effects },
  );
  console.log("firings", result.firings, "pulses", result.pulses);
  console.log("residue", JSON.stringify(result.residue ?? null));
  console.log("unmet", JSON.stringify((result as any).unmet ?? null));
  
}
main();
