// NYC bus ingest: OBA NYC GTFS-realtime VehiclePositions (real GPS, no key).
// Buses have direct lat/lon, so we emit VehicleState with `pos` (no shape).
//
// Run standalone to smoke-test: npx tsx ingest/nyc-bus.ts

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VehicleState } from "../shared/types.ts";
import { decodeOccupancy } from "../shared/occupancy.ts";

const FEED = "https://gtfsrt.prod.obanyc.com/vehiclePositions";
const BUS_COLOR = "#F0A830"; // warm amber — reads distinctly from the cyan trains

function toNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const a = v as { toNumber?: () => number };
  if (typeof a.toNumber === "function") return a.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchNycBuses(): Promise<VehicleState[]> {
  const out: VehicleState[] = [];
  try {
    const res = await fetch(FEED);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(await res.arrayBuffer())
    );
    const ts = toNum(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000);
    for (const e of feed.entity) {
      const ve = e.vehicle;
      const p = ve?.position;
      if (!p || p.latitude == null || p.longitude == null) continue;
      const route = ve!.trip?.routeId || ve!.vehicle?.label || "BUS";
      const occ = decodeOccupancy(ve!);
      out.push({
        id: `nyc-bus:${e.id}`,
        city: "nyc",
        mode: "bus",
        route: String(route).replace(/^MTA NYCT_/, ""),
        color: BUS_COLOR,
        shapeId: null,
        dist: 0,
        speed: Math.max(5, toNum(p.speed) ?? 7), // m/s; floor so buses always creep
        bearing: p.bearing ?? 0,
        pos: [p.longitude, p.latitude],
        elevation: "surface",
        stale: Math.floor(Date.now() / 1000) - ts > 180,
        occStatus: occ.occStatus,
        occPct: occ.occPct,
      });
    }
  } catch (e) {
    console.error("[nyc-bus] error:", (e as Error).message);
  }
  // User-requested cap: 150 buses. Bloom + buildings are the visual priority;
  // buses are ambience.
  return out.slice(0, 150);
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const buses = await fetchNycBuses();
  console.log(`[nyc-bus] ${buses.length} buses with GPS`);
  for (const b of buses.slice(0, 6)) {
    console.log(`  ${b.route.padEnd(6)} @ [${b.pos![0].toFixed(4)}, ${b.pos![1].toFixed(4)}] bearing ${Math.round(b.bearing ?? 0)}°`);
  }
}
