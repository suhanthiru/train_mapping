// GTFS-realtime OccupancyStatus enum -> name. Both NYC subway and OBA bus
// feeds populate this (verified live: 100% of vehicles carry it). Order
// matches the GTFS-rt spec's enum values 0..8.
const OCC_NAMES = [
  "EMPTY",
  "MANY_SEATS_AVAILABLE",
  "FEW_SEATS_AVAILABLE",
  "STANDING_ROOM_ONLY",
  "CRUSHED_STANDING_ROOM_ONLY",
  "FULL",
  "NOT_ACCEPTING_PASSENGERS",
  "NO_DATA_AVAILABLE",
  "NOT_BOARDABLE",
];

/** Decode a vehicle entity's occupancy into { occStatus, occPct }. */
export function decodeOccupancy(vehicle: {
  occupancyStatus?: number | null;
  occupancyPercentage?: number | null | { toNumber?: () => number };
}): { occStatus?: string; occPct?: number } {
  const out: { occStatus?: string; occPct?: number } = {};
  const s = vehicle.occupancyStatus;
  if (s != null && s >= 0 && s < OCC_NAMES.length && OCC_NAMES[s] !== "NO_DATA_AVAILABLE") {
    out.occStatus = OCC_NAMES[s];
  }
  const p = vehicle.occupancyPercentage as any;
  if (p != null) {
    const n = typeof p === "number" ? p : typeof p.toNumber === "function" ? p.toNumber() : Number(p);
    if (Number.isFinite(n) && n >= 0) out.occPct = n;
  }
  return out;
}
