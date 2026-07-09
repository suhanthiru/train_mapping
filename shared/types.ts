// Normalized data model shared across all cities/adapters.
// See PROJECT_SPEC.md §5.

export type City = "nyc" | "atl" | "par";
export type Mode = "subway" | "bus" | "tram" | "rail";
export type Elevation = "underground" | "surface" | "elevated";

/** Live vehicle state broadcast over WebSocket. Kept small. */
export interface VehicleState {
  id: string; // `${city}:${tripId}`
  city: City;
  mode: Mode;
  route: string; // "A", "RER B", "MARTA Red"
  color: string; // hex, real official agency color
  shapeId: string | null; // null => positioned by `pos` (buses) or straight-line fallback
  dist: number; // meters along shape — backend's computed truth (trains)
  speed: number; // m/s, for client-side tween
  bearing?: number;
  pos?: [number, number]; // [lon,lat] direct position (buses have GPS, no shape)
  measuredDist?: number; // raw anchored dist BEFORE the continuity clamp (Kalman input)
  uncertainty?: number; // √(position variance), meters — from the Kalman sidecar (Phase 2)
  elevation: Elevation;
  nextStop?: string;
  nextStopName?: string;
  delay?: number; // seconds, +late / -early
  stale?: boolean;
}

/** A track polyline with precomputed cumulative distance at each vertex. */
export interface Shape {
  id: string;
  pts: [number, number][]; // [lon, lat]
  cum: number[]; // cumulative meters, cum[0] = 0
}

export interface Stop {
  id: string;
  name: string;
  pos: [number, number]; // [lon, lat]
  parent?: string;
  connectedRoutes: string[]; // filled by preprocess (may be empty in early builds)
}

export interface RouteInfo {
  id: string;
  color: string; // "#RRGGBB"
  textColor: string;
  shortName: string;
  longName: string;
}

/** trip_id -> static trip metadata, used for realtime trip→shape matching. */
export interface TripInfo {
  routeId: string;
  shapeId: string;
  directionId: number;
}

/** Raw normalized output of an ingest adapter, pre-interpolation. */
export interface RawVehicle {
  tripId: string;
  routeId: string;
  mode: Mode;
  // Anchors for interpolation (§6): where it is between two stops in time.
  fromStopId?: string;
  toStopId?: string;
  departTime?: number; // epoch seconds
  arriveTime?: number; // epoch seconds (predicted)
  currentStatus?: "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";
  atStopId?: string;
  feedTimestamp: number; // epoch seconds
  upcoming?: { stopId: string; time: number }[]; // future stops (for arrivals boards)
}

/** A row persisted to the rolling-7-day SQLite history (§5). */
export interface HistorySnapshot {
  ts: number;
  vehicleId: string;
  dist: number;
  speed: number;
  delay?: number;
}
