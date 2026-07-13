// THE service/config constants — single source of truth (roadmap P3).
// Before this module: ports were hardcoded independently in server/index.ts,
// dashboard/app.js, web/src/main.ts, scripts/dev-all, docs/hub.html; the NYC
// trip-id/shape-id parsing was reimplemented in ledger.ts and main.ts; and the
// UI accent colors were scattered as string literals. One authority now.
//
// Consumers: server/* + history/* + scripts/* import directly (tsx),
// web/src/* imports via vite. dashboard/app.js can't import TS (no build
// step) — `npm run gen:config` writes dashboard/config.js from these values
// (generated file, marked as such; regenerate after edits here).
// docs/hub.html shows ports as display text only — update it when these change.

export const PORTS = {
  backend: 8080,      // Node: ingest + WS + map + /hub + /docs
  analyticsGo: 8090,  // Go: streaming analytics (has its own /anomalies)
  analyticsPy: 8091,  // Python: ETA models + anomaly scoring (FastAPI)
  kalmanRs: 8092,     // Rust: position/uncertainty filter
  dashboard: 4174,    // static Chart.js dashboard
  webDev: 5173,       // vite dev server (HMR)
} as const;

// Node-side service URLs (env-overridable for Docker; 127.0.0.1 not localhost —
// Windows resolves localhost to ::1 first while the services bind IPv4-only,
// measured costing ~2s per fresh connection).
export function nodeServiceUrls(env: Record<string, string | undefined>) {
  return {
    analyticsPy: env.ANALYTICS_PY ?? `http://127.0.0.1:${PORTS.analyticsPy}`,
    kalmanRs: env.KALMAN_RS ?? `http://127.0.0.1:${PORTS.kalmanRs}`,
  };
}

// Shared UI palette (map + dashboard + docs pages)
export const COLORS = {
  accent: "#3FD8FF",  // cyan — primary accent / default route color
  amber: "#F0A830",   // buses / warnings
  axis: "#8b98a5",
  grid: "#1f2937",
} as const;

// NYC id parsing — the ONE definition.
// trip_id "015200_1..N10R" -> route "1"; shape id "1..N10R" -> route "1".
export function routeFromTripId(tripId: string): string | null {
  return tripId.split("_")[1]?.split("..")[0] ?? null;
}
export function routeFromShapeId(shapeId: string): string {
  return shapeId.split("..")[0];
}

// The tracker's local-time features (segments.hour/dow) are NYC-local by
// definition. The host running the ledger is assumed America/New_York (see
// ledger.ts buildSegments) — pin the assumption here so a future non-ET host
// has exactly one constant to confront.
export const TZ = "America/New_York";
