// Diagnostic: quantify what the live feed actually provides, to guide
// interpolation fixes. Run: npx tsx core/diag.ts
import { fetchNycVehicles } from "../ingest/nyc.ts";

const raws = await fetchNycVehicles();
const now = Math.floor(Date.now() / 1000);

const has = (p: (v: any) => boolean) => raws.filter(p).length;
const status: Record<string, number> = {};
for (const v of raws) status[v.currentStatus ?? "none"] = (status[v.currentStatus ?? "none"] ?? 0) + 1;

console.log(`total raw: ${raws.length}`);
console.log(`  with toStopId:        ${has((v) => v.toStopId)}`);
console.log(`  with arriveTime:      ${has((v) => v.arriveTime)}`);
console.log(`  with toStop+arrive:   ${has((v) => v.toStopId && v.arriveTime)}`);
console.log(`  arriveTime in future: ${has((v) => v.arriveTime && v.arriveTime > now)}`);
console.log(`  arriveTime in past:   ${has((v) => v.arriveTime && v.arriveTime <= now)}`);
console.log(`  with atStopId:        ${has((v) => v.atStopId)}`);
console.log(`  with fromStopId:      ${has((v) => v.fromStopId)}`);
console.log(`  currentStatus breakdown:`, status);

// vehicles with a status but no toStop — candidates for deriving toStop from the vehicle
console.log(
  `  IN_TRANSIT/INCOMING w/ atStop but no toStop: ${has(
    (v) => (v.currentStatus === "IN_TRANSIT_TO" || v.currentStatus === "INCOMING_AT") && v.atStopId && !v.toStopId
  )}`
);
