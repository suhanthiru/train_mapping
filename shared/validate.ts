// Ingest schema validation: reject malformed/implausible GTFS-rt records at
// the adapter boundary, BEFORE they reach the ledger/history DBs — a bad feed
// frame must never quietly poison training data. Conservative by design: only
// drop what is provably unusable; when in doubt, let it through (the ledger's
// own guards and buildSegments' travel-time filters are the second line).

import type { RawVehicle } from "./types.ts";

// Prediction horizon sanity: a subway "upcoming arrival" more than 3h out (or
// more than 5min in the past) is feed junk, not a plan.
const MAX_HORIZON_S = 3 * 3600;
const MAX_PAST_S = 5 * 60;
// A feed timestamp this far from our clock means the frame is stale/garbled.
const MAX_FEED_SKEW_S = 3600;

export interface ValidationStats {
  vehiclesDropped: number;
  upcomingDropped: number;
  reasons: Record<string, number>;
}

function bump(stats: ValidationStats, reason: string): void {
  stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
}

/**
 * Validate + clean one adapter's output in place. Returns only the vehicles
 * that survive; per-field junk (bad upcoming entries) is stripped rather than
 * dooming the whole vehicle.
 */
export function validateRawVehicles(
  raws: RawVehicle[],
  now = Math.floor(Date.now() / 1000)
): { vehicles: RawVehicle[]; stats: ValidationStats } {
  const stats: ValidationStats = { vehiclesDropped: 0, upcomingDropped: 0, reasons: {} };
  const out: RawVehicle[] = [];

  for (const v of raws) {
    if (!v.tripId || typeof v.tripId !== "string") {
      stats.vehiclesDropped++; bump(stats, "missing_trip_id"); continue;
    }
    if (!Number.isFinite(v.feedTimestamp) || v.feedTimestamp <= 0) {
      stats.vehiclesDropped++; bump(stats, "bad_feed_timestamp"); continue;
    }
    if (Math.abs(now - v.feedTimestamp) > MAX_FEED_SKEW_S) {
      stats.vehiclesDropped++; bump(stats, "feed_timestamp_skew"); continue;
    }

    if (v.upcoming?.length) {
      const cleaned = v.upcoming.filter((u) => {
        const ok =
          !!u.stopId &&
          Number.isFinite(u.time) &&
          u.time > now - MAX_PAST_S &&
          u.time < now + MAX_HORIZON_S;
        if (!ok) { stats.upcomingDropped++; bump(stats, "bad_upcoming_entry"); }
        return ok;
      });
      v.upcoming = cleaned.length ? cleaned : undefined;
    }

    // STOPPED_AT without a stop id can't produce a ground-truth actual — keep
    // the vehicle (position is still fine) but clear the inconsistent status.
    if (v.currentStatus === "STOPPED_AT" && !v.atStopId) {
      v.currentStatus = undefined; bump(stats, "stopped_at_without_stop");
    }

    out.push(v);
  }
  return { vehicles: out, stats };
}

/** Rough NYC bounding box for bus GPS plausibility (lon, lat). */
export function inNycBounds(lon: number, lat: number): boolean {
  return lon > -74.6 && lon < -73.4 && lat > 40.3 && lat < 41.2;
}
