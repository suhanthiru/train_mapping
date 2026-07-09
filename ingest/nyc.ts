// NYC ingest adapter: fetch + decode live GTFS-realtime protobuf into RawVehicle[].
// No API key required. Standard GTFS-rt fields decode fine even though the MTA
// feeds carry NYCT protobuf extensions (unknown fields are ignored). §4.
//
// Run standalone to smoke-test against the live feed: npm run ingest:nyc

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawVehicle, Stop } from "../shared/types.ts";
import { validateRawVehicles } from "../shared/validate.ts";

// The MTA splits the subway into feeds by line group. %2F = "/" (nyct/<feed>).
const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
const FEEDS = [
  "gtfs", // 1 2 3 4 5 6 7 S
  "gtfs-ace",
  "gtfs-bdfm",
  "gtfs-g",
  "gtfs-jz",
  "gtfs-nqrw",
  "gtfs-l",
  "gtfs-si", // Staten Island Railway
];

// protobufjs returns int64 as Long; normalize to a JS number (epoch seconds).
function toNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const anyv = v as { toNumber?: () => number };
  if (typeof anyv.toNumber === "function") return anyv.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchNycVehicles(): Promise<RawVehicle[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      // 8s cap: the only fetch in this codebase that lacked a timeout — a
      // hung MTA connection (feed slow/unreachable) would otherwise pile up
      // unresolved sockets and, empirically, stall the whole process (even
      // unrelated same-process HTTP handlers stopped responding).
      const res = await fetch(BASE + f, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
    })
  );

  const out = new Map<string, RawVehicle>();

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const feed = r.value;
    const feedTs = toNum(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000);

    for (const ent of feed.entity) {
      // --- TripUpdate: predicted arrivals at upcoming stops ---
      if (ent.tripUpdate?.trip) {
        const tu = ent.tripUpdate;
        const tripId = tu.trip.tripId ?? ent.id;
        const routeId = tu.trip.routeId ?? "";
        const stus = tu.stopTimeUpdate ?? [];

        // next stop = first update with a future arrival/departure
        let toStopId: string | undefined;
        let arriveTime: number | undefined;
        let fromStopId: string | undefined;
        let departTime: number | undefined;

        for (let i = 0; i < stus.length; i++) {
          const t =
            toNum(stus[i].arrival?.time) ?? toNum(stus[i].departure?.time);
          if (t != null && t >= feedTs - 30) {
            toStopId = stus[i].stopId ?? undefined;
            arriveTime = t;
            // previous update (if any) is the segment origin
            if (i > 0) {
              fromStopId = stus[i - 1].stopId ?? undefined;
              departTime =
                toNum(stus[i - 1].departure?.time) ??
                toNum(stus[i - 1].arrival?.time);
            }
            break;
          }
        }

        // full upcoming-stop list for arrivals boards
        const upcoming = stus
          .map((su) => ({
            stopId: su.stopId ?? "",
            time: toNum(su.arrival?.time) ?? toNum(su.departure?.time) ?? 0,
          }))
          .filter((u) => u.stopId && u.time >= feedTs - 30)
          .slice(0, 8);

        const v = out.get(tripId) ?? {
          tripId,
          routeId,
          mode: "subway" as const,
          feedTimestamp: feedTs,
        };
        v.routeId = routeId || v.routeId;
        v.toStopId = toStopId ?? v.toStopId;
        v.arriveTime = arriveTime ?? v.arriveTime;
        v.fromStopId = fromStopId ?? v.fromStopId;
        v.departTime = departTime ?? v.departTime;
        if (upcoming.length) v.upcoming = upcoming;
        out.set(tripId, v);
      }

      // --- VehiclePosition: current status + stop ---
      if (ent.vehicle?.trip) {
        const ve = ent.vehicle;
        const tripId = ve.trip!.tripId ?? ent.id;
        const routeId = ve.trip!.routeId ?? "";
        const statusMap = ["INCOMING_AT", "STOPPED_AT", "IN_TRANSIT_TO"] as const;
        const v = out.get(tripId) ?? {
          tripId,
          routeId,
          mode: "subway" as const,
          feedTimestamp: feedTs,
        };
        v.routeId = routeId || v.routeId;
        v.currentStatus =
          ve.currentStatus != null ? statusMap[ve.currentStatus] : v.currentStatus;
        v.atStopId = ve.stopId ?? v.atStopId;
        out.set(tripId, v);
      }
    }
  }

  // Schema validation at the adapter boundary: drop malformed/implausible
  // records before they can reach the ledger and poison training data.
  const { vehicles, stats } = validateRawVehicles([...out.values()]);
  if (stats.vehiclesDropped || stats.upcomingDropped) {
    console.warn(
      `[nyc-ingest] validation dropped ${stats.vehiclesDropped} vehicles, ` +
      `${stats.upcomingDropped} upcoming entries:`, stats.reasons
    );
  }
  return vehicles;
}

// --- standalone smoke test ---
const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const vehicles = await fetchNycVehicles();
  console.log(`[nyc-ingest] decoded ${vehicles.length} active trips`);

  // resolve stop names for a readable sample
  let stops: Record<string, Stop> = {};
  try {
    stops = JSON.parse(
      readFileSync(join(process.cwd(), "data", "nyc", "stops.json"), "utf8")
    );
  } catch {
    /* preprocess not run yet */
  }
  const nm = (id?: string) => (id && stops[id]?.name) || id || "?";

  const withNext = vehicles.filter((v) => v.toStopId && v.arriveTime);
  console.log(`[nyc-ingest] ${withNext.length} have a next-stop prediction`);
  for (const v of withNext.slice(0, 8)) {
    const eta = v.arriveTime! - Math.floor(Date.now() / 1000);
    console.log(
      `  ${v.routeId.padEnd(3)} trip ${v.tripId.slice(-12).padStart(12)} | ` +
        `${(v.currentStatus ?? "-").padEnd(13)} -> ${nm(v.toStopId).padEnd(22)} ` +
        `ETA ${eta >= 0 ? eta + "s" : "due"}`
    );
  }
}
