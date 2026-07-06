// MTA subway service-alerts adapter (GTFS-realtime, no API key). Forward-only
// feature for the model: which lines are flagged slow / delayed / suspended /
// under planned work right now — causal signal that can't be backfilled.
//
// Run standalone to smoke-test: tsx ingest/nyc-alerts.ts

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALERTS_URL =
  process.env.NYC_ALERTS_URL ??
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";

export interface AlertRow {
  routeId: string;
  direction: string; // "N" | "S" | "" (subway alerts are usually whole-route)
  alertType: string; // GTFS-rt Effect enum name, e.g. SIGNIFICANT_DELAYS
  severity: number; // GTFS-rt severityLevel (0..3)
  header: string;
}

// MTA leaves the standard GTFS-rt `effect` as UNKNOWN and puts the real
// category in the header text (+ a Mercury extension). Classify from the header
// — coarse but robust, and it's the causal signal the model wants.
function classify(header: string): string {
  const h = header.toLowerCase();
  if (/\bsuspend|no .*service|not running\b/.test(h)) return "SUSPENDED";
  if (/\bdelay/.test(h)) return "DELAYS";
  if (/\bslow/.test(h)) return "SLOW_SPEEDS";
  if (/planned work|scheduled|maintenance/.test(h)) return "PLANNED_WORK";
  if (/reduced/.test(h)) return "REDUCED_SERVICE";
  if (/additional|extra .*service/.test(h)) return "ADDITIONAL_SERVICE";
  if (/reroute|bypass|skip|express|local|runs? on|via /.test(h)) return "SERVICE_CHANGE";
  return "OTHER";
}

export async function fetchNycAlerts(): Promise<AlertRow[]> {
  const res = await fetch(ALERTS_URL);
  if (!res.ok) throw new Error(`alerts HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
  const now = Math.floor(Date.now() / 1000);
  const num = (v: unknown): number => (v == null ? 0 : typeof v === "number" ? v : Number((v as any).toNumber?.() ?? v));

  const byKey = new Map<string, AlertRow>(); // dedupe: routeId|direction|alertType
  for (const ent of feed.entity) {
    const a = ent.alert;
    if (!a) continue;
    const active =
      !a.activePeriod?.length ||
      a.activePeriod.some((p) => {
        const start = p.start ? num(p.start) : 0;
        const end = p.end ? num(p.end) : Infinity;
        return now >= start && now <= end;
      });
    if (!active) continue;

    const header = a.headerText?.translation?.[0]?.text ?? "";
    const alertType = classify(header);
    const severity = a.severityLevel != null ? Number(a.severityLevel) : 0;

    for (const ie of a.informedEntity ?? []) {
      const routeId = ie.routeId ?? "";
      if (!routeId) continue; // route-level alerts only
      const direction = ie.directionId === 0 ? "N" : ie.directionId === 1 ? "S" : "";
      const key = `${routeId}|${direction}|${alertType}`;
      if (!byKey.has(key)) byKey.set(key, { routeId, direction, alertType, severity, header: header.slice(0, 200) });
    }
  }
  return [...byKey.values()];
}

// --- standalone smoke test ---
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const alerts = await fetchNycAlerts();
  console.log(`[alerts] ${alerts.length} active route-alerts`);
  const byType: Record<string, number> = {};
  for (const a of alerts) byType[a.alertType] = (byType[a.alertType] ?? 0) + 1;
  console.log("[alerts] by type:", byType);
  for (const a of alerts.slice(0, 6)) console.log(`  ${a.routeId} ${a.alertType} sev=${a.severity} — ${a.header.slice(0, 60)}`);
}
