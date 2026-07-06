// Bitemporal prediction ledger: records the GTFS-realtime feed's EVOLVING
// arrival predictions (with when-we-knew-them), the eventual ACTUAL arrivals
// (ground truth), and city weather over time — the data foundation for an ETA
// backtest (feed accuracy vs. lead time) and a later ETA model whose features
// are occupancy + weather + time/route context. Separate DB from history.db so
// it's fully additive. Uses Node 24's built-in node:sqlite (no native build).
//
// Grain: recording hooks the 30s feed poll (fetchTick), not the 4s pushTick —
// predictions only change per poll, so anything faster is duplicate rows.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RawVehicle } from "../shared/types.ts";
import { haversine } from "../shared/geo.ts";

// 30-day retention (longer than history.db's 7d) — this data trains the ETA
// model AND backs graph analytics, and more history means a better model.
const RETAIN_SECONDS = 30 * 24 * 3600;
// Only log a prediction row when the predicted arrival for a (trip, stop) moves
// more than this vs. the last logged value — bounds volume and makes each row a
// meaningful "belief revision" rather than a poll-by-poll duplicate.
const PRED_CHANGE_THRESHOLD_S = 20;

export interface LeadTimeBucket {
  leadLabel: string;
  n: number;
  maeSec: number; // mean absolute error
  biasSec: number; // mean signed error (pred - actual); + = feed predicts too late
}

export class PredictionLedger {
  private db: DatabaseSync;
  private insPred;
  private insActual;
  private insCond;
  private insModelPred;
  private insAccSnap;
  private insVehLog;
  private insAlert;
  // in-memory change-detection: "tripId|stopId" -> last logged pred_arrival
  private lastPred = new Map<string, number>();
  // vehicle_log change-detection: tripId -> last {toStop, frac, ahead}
  private lastVehLog = new Map<string, { toStop: string; frac: number; ahead: number }>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        trip_id      TEXT NOT NULL,
        stop_id      TEXT NOT NULL,
        route_id     TEXT,
        pred_arrival INTEGER NOT NULL,  -- valid time: predicted arrival (epoch s)
        observed_at  INTEGER NOT NULL,  -- transaction time: feed ts we saw it (epoch s)
        occ_status   TEXT,
        occ_pct      REAL,
        source       TEXT NOT NULL DEFAULT 'gtfs-rt'
      );
      CREATE INDEX IF NOT EXISTS idx_pred_key ON predictions(trip_id, stop_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_pred_observed ON predictions(observed_at);

      CREATE TABLE IF NOT EXISTS actuals (
        trip_id        TEXT NOT NULL,
        stop_id        TEXT NOT NULL,
        actual_arrival INTEGER NOT NULL, -- first feed ts we saw STOPPED_AT (upper bound)
        UNIQUE(trip_id, stop_id)
      );

      CREATE TABLE IF NOT EXISTS conditions (
        ts            INTEGER NOT NULL,  -- when sampled (epoch s)
        weather_score INTEGER,           -- 0-100 severity
        temp_f        REAL,
        precipitating INTEGER,
        conditions    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cond_ts ON conditions(ts);

      -- Forward-only feature loggers (Phase 1): live quantities that CANNOT be
      -- backfilled, so they must be captured continuously going forward.
      CREATE TABLE IF NOT EXISTS vehicle_log (
        ts           INTEGER NOT NULL,
        trip_id      TEXT NOT NULL,
        route        TEXT,
        from_stop    TEXT,     -- current hop the train is in
        to_stop      TEXT,
        frac_hop     REAL,     -- 0..1 position within the current hop (from Kalman dist)
        kalman_speed REAL,     -- m/s, filtered
        uncertainty  REAL,     -- sqrt(position variance), meters
        trains_ahead INTEGER   -- congestion: same-shape trains within a window ahead
      );
      CREATE INDEX IF NOT EXISTS idx_vehlog_ts ON vehicle_log(ts);
      CREATE INDEX IF NOT EXISTS idx_vehlog_trip ON vehicle_log(trip_id, to_stop, ts);

      CREATE TABLE IF NOT EXISTS alerts_log (
        ts         INTEGER NOT NULL,
        route_id   TEXT,
        direction  TEXT,     -- N/S when known
        alert_type TEXT,     -- e.g. planned_work / alert
        severity   INTEGER,  -- MTA code (Slow Speeds=16, Delays=22, Suspended=39)
        header     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts_log(ts);
      CREATE INDEX IF NOT EXISTS idx_alerts_route ON alerts_log(route_id, ts);

      -- Materialized segment traversals: one row per consecutive (from_stop ->
      -- to_stop) hop per trip. Simultaneously the graph EDGE LIST (nodes=stops)
      -- and the XGBoost TRAINING TABLE. Rebuilt by buildSegments().
      CREATE TABLE IF NOT EXISTS segments (
        trip_id       TEXT NOT NULL,
        route_id      TEXT,
        from_stop     TEXT NOT NULL,
        to_stop       TEXT NOT NULL,
        depart_ts     INTEGER NOT NULL,
        arrive_ts     INTEGER NOT NULL,
        travel_sec    INTEGER NOT NULL,
        weather_score INTEGER,
        occ_status    TEXT,
        occ_pct       REAL,
        hour          INTEGER,   -- local hour-of-day of arrival (0-23)
        dow           INTEGER,   -- local day-of-week of arrival (0=Sun)
        distance_m    REAL,      -- straight-line meters from_stop -> to_stop (Phase 2)
        elevation     TEXT       -- underground/surface/elevated (Phase 2)
      );
      CREATE INDEX IF NOT EXISTS idx_seg_route ON segments(route_id);
      CREATE INDEX IF NOT EXISTS idx_seg_stops ON segments(from_stop, to_stop);
      CREATE INDEX IF NOT EXISTS idx_seg_arrive ON segments(arrive_ts);

      -- Periodic accuracy snapshots so the dashboard can trend accuracy over
      -- time (one row per lead-time bucket per snapshot per source).
      CREATE TABLE IF NOT EXISTS accuracy_snapshots (
        ts         INTEGER NOT NULL,
        source     TEXT NOT NULL,
        lead_label TEXT NOT NULL,
        n          INTEGER,
        mae_sec    INTEGER,
        bias_sec   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_accsnap_ts ON accuracy_snapshots(ts);
    `);
    this.insPred = this.db.prepare(
      `INSERT INTO predictions (trip_id, stop_id, route_id, pred_arrival, observed_at, occ_status, occ_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.insActual = this.db.prepare(
      `INSERT OR IGNORE INTO actuals (trip_id, stop_id, actual_arrival) VALUES (?, ?, ?)`
    );
    this.insCond = this.db.prepare(
      `INSERT INTO conditions (ts, weather_score, temp_f, precipitating, conditions) VALUES (?, ?, ?, ?, ?)`
    );
    this.insModelPred = this.db.prepare(
      `INSERT INTO predictions (trip_id, stop_id, route_id, pred_arrival, observed_at, source)
       VALUES (?, ?, ?, ?, ?, 'model-v1')`
    );
    this.insAccSnap = this.db.prepare(
      `INSERT INTO accuracy_snapshots (ts, source, lead_label, n, mae_sec, bias_sec) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.insVehLog = this.db.prepare(
      `INSERT INTO vehicle_log (ts, trip_id, route, from_stop, to_stop, frac_hop, kalman_speed, uncertainty, trains_ahead)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.insAlert = this.db.prepare(
      `INSERT INTO alerts_log (ts, route_id, direction, alert_type, severity, header) VALUES (?, ?, ?, ?, ?, ?)`
    );
  }

  /** Log the feed's evolving arrival predictions (change-detected, bitemporal). */
  recordPredictions(raws: RawVehicle[]): void {
    this.db.exec("BEGIN");
    try {
      for (const v of raws) {
        if (!v.upcoming) continue;
        for (const u of v.upcoming) {
          if (!u.stopId || !u.time) continue;
          const key = `${v.tripId}|${u.stopId}`;
          const prev = this.lastPred.get(key);
          if (prev !== undefined && Math.abs(u.time - prev) <= PRED_CHANGE_THRESHOLD_S) {
            continue; // unchanged belief — skip duplicate row
          }
          this.lastPred.set(key, u.time);
          this.insPred.run(
            v.tripId,
            u.stopId,
            v.routeId,
            u.time,
            v.feedTimestamp,
            v.occStatus ?? null,
            v.occPct ?? null
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Log the ETA model's own arrival-time predictions (source='model-v1'), in
   * the same table/shape as the feed's, so accuracyByLeadTime()/accuracyTrend()
   * grade them identically for a head-to-head backtest. Change-detected with a
   * separate key namespace so it can't collide with the feed's own tracking.
   */
  recordModelPredictions(rows: { tripId: string; stopId: string; routeId: string; predArrival: number; observedAt: number }[]): void {
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const key = `model:${r.tripId}|${r.stopId}`;
        const prev = this.lastPred.get(key);
        if (prev !== undefined && Math.abs(r.predArrival - prev) <= PRED_CHANGE_THRESHOLD_S) {
          continue; // unchanged belief — skip duplicate row
        }
        this.lastPred.set(key, r.predArrival);
        this.insModelPred.run(r.tripId, r.stopId, r.routeId, r.predArrival, r.observedAt);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Record ground-truth arrivals: first poll a trip is seen STOPPED_AT a stop. */
  recordActuals(raws: RawVehicle[]): void {
    this.db.exec("BEGIN");
    try {
      for (const v of raws) {
        if (v.currentStatus === "STOPPED_AT" && v.atStopId) {
          this.insActual.run(v.tripId, v.atStopId, v.feedTimestamp);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Sample the current city weather severity (0-100) into the ledger. */
  recordConditions(ts: number, score: number | null, tempF: number | null, precipitating: boolean, conditions: string | null): void {
    this.insCond.run(ts, score, tempF, precipitating ? 1 : 0, conditions);
  }

  /**
   * Log forward-only per-vehicle state: Kalman progress into the current hop +
   * live congestion (trains ahead). Change-detected — only writes when a train
   * meaningfully advances (frac moved >0.1), changes hop, or its congestion
   * count changes — so the 4s tick doesn't flood the table. CANNOT be
   * backfilled, which is why it must be captured live.
   */
  recordVehicleLog(rows: { ts: number; tripId: string; route: string; fromStop: string; toStop: string; fracHop: number; kalmanSpeed: number; uncertainty: number; trainsAhead: number }[]): void {
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const prev = this.lastVehLog.get(r.tripId);
        if (prev && prev.toStop === r.toStop && Math.abs(prev.frac - r.fracHop) < 0.1 && prev.ahead === r.trainsAhead) {
          continue; // no material change — skip
        }
        this.lastVehLog.set(r.tripId, { toStop: r.toStop, frac: r.fracHop, ahead: r.trainsAhead });
        this.insVehLog.run(r.ts, r.tripId, r.route, r.fromStop, r.toStop, r.fracHop, r.kalmanSpeed, r.uncertainty, r.trainsAhead);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Snapshot the currently-active service alerts (one row per alert per sample). */
  recordAlerts(ts: number, alerts: { routeId: string; direction: string; alertType: string; severity: number; header: string }[]): void {
    this.db.exec("BEGIN");
    try {
      for (const a of alerts) {
        this.insAlert.run(ts, a.routeId, a.direction || null, a.alertType, a.severity, a.header);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * The backtest: for every (trip, stop) with a known actual arrival, take each
   * earlier prediction, compute lead time (actual - observed_at) and error
   * (pred - actual), and aggregate MAE + signed bias into lead-time buckets.
   */
  accuracyByLeadTime(source = "gtfs-rt"): LeadTimeBucket[] {
    const rows = this.db
      .prepare(
        `SELECT
           (a.actual_arrival - p.observed_at) AS lead,
           (p.pred_arrival - a.actual_arrival) AS err
         FROM predictions p
         JOIN actuals a ON a.trip_id = p.trip_id AND a.stop_id = p.stop_id
         WHERE p.source = ?
           AND p.observed_at <= a.actual_arrival
           AND (a.actual_arrival - p.observed_at) BETWEEN 0 AND 1800`
      )
      .all(source) as { lead: number; err: number }[];

    const buckets: { label: string; lo: number; hi: number }[] = [
      { label: "0-1 min", lo: 0, hi: 60 },
      { label: "1-2 min", lo: 60, hi: 120 },
      { label: "2-5 min", lo: 120, hi: 300 },
      { label: "5-10 min", lo: 300, hi: 600 },
      { label: "10+ min", lo: 600, hi: Infinity },
    ];
    return buckets.map((b) => {
      const inB = rows.filter((r) => r.lead >= b.lo && r.lead < b.hi);
      const n = inB.length;
      const maeSec = n ? inB.reduce((s, r) => s + Math.abs(r.err), 0) / n : 0;
      const biasSec = n ? inB.reduce((s, r) => s + r.err, 0) / n : 0;
      return {
        leadLabel: b.label,
        n,
        maeSec: Math.round(maeSec),
        biasSec: Math.round(biasSec),
      };
    });
  }

  /**
   * (Re)materialize `segments` from `actuals`: pair each trip's consecutive
   * observed arrivals into (from_stop -> to_stop) hops with travel time,
   * enriched with nearest weather + that trip/stop's occupancy + local hour/dow.
   * Cheap full rebuild — call on a slow timer / on demand. Returns rows written.
   */
  buildSegments(stopPos?: Record<string, [number, number]>, stopElev?: Record<string, string>): number {
    // idempotent column adds (for ledgers created before Phase 2)
    for (const col of ["distance_m REAL", "elevation TEXT"]) {
      try { this.db.exec(`ALTER TABLE segments ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    const actuals = this.db
      .prepare("SELECT trip_id, stop_id, actual_arrival FROM actuals ORDER BY trip_id, actual_arrival")
      .all() as { trip_id: string; stop_id: string; actual_arrival: number }[];

    const wxStmt = this.db.prepare(
      "SELECT weather_score FROM conditions WHERE ts <= ? ORDER BY ts DESC LIMIT 1"
    );
    const occStmt = this.db.prepare(
      "SELECT occ_status, occ_pct FROM predictions WHERE trip_id = ? AND stop_id = ? ORDER BY observed_at DESC LIMIT 1"
    );
    const ins = this.db.prepare(
      `INSERT INTO segments
         (trip_id, route_id, from_stop, to_stop, depart_ts, arrive_ts, travel_sec, weather_score, occ_status, occ_pct, hour, dow, distance_m, elevation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM segments");
      let n = 0;
      for (let i = 1; i < actuals.length; i++) {
        const a = actuals[i - 1];
        const b = actuals[i];
        if (a.trip_id !== b.trip_id) continue; // segment must be within one trip
        const travel = b.actual_arrival - a.actual_arrival;
        if (travel < 10 || travel > 1800) continue; // drop bad pairings / long gaps
        // NYC trip_id like "015200_1..N10R" -> route "1"
        const routeId = b.trip_id.split("_")[1]?.split("..")[0] ?? null;
        const wx = wxStmt.get(b.actual_arrival) as { weather_score: number } | undefined;
        const occ = occStmt.get(b.trip_id, b.stop_id) as { occ_status: string; occ_pct: number } | undefined;
        const d = new Date(b.actual_arrival * 1000); // local tz (assumed ET on the host)
        const pf = stopPos?.[a.stop_id];
        const pt = stopPos?.[b.stop_id];
        const distance = pf && pt ? Math.round(haversine(pf, pt)) : null;
        const elevation = stopElev?.[b.stop_id] ?? stopElev?.[a.stop_id] ?? null;
        ins.run(
          b.trip_id, routeId, a.stop_id, b.stop_id,
          a.actual_arrival, b.actual_arrival, travel,
          wx?.weather_score ?? null,
          occ?.occ_status ?? null, occ?.occ_pct ?? null,
          d.getHours(), d.getDay(), distance, elevation
        );
        n++;
      }
      this.db.exec("COMMIT");
      return n;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Delete rows older than the retention window across all ledger tables. */
  prune(now = Math.floor(Date.now() / 1000)): number {
    const cutoff = now - RETAIN_SECONDS;
    let removed = 0;
    removed += Number(this.db.prepare("DELETE FROM predictions WHERE observed_at < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM actuals WHERE actual_arrival < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM conditions WHERE ts < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM segments WHERE arrive_ts < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM accuracy_snapshots WHERE ts < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM vehicle_log WHERE ts < ?").run(cutoff).changes ?? 0);
    removed += Number(this.db.prepare("DELETE FROM alerts_log WHERE ts < ?").run(cutoff).changes ?? 0);
    // forget stale change-detection keys so the maps don't grow unbounded
    for (const [k, t] of this.lastPred) if (t < cutoff) this.lastPred.delete(k);
    return removed;
  }

  /** Row counts for quick verification / status. */
  counts(): { predictions: number; actuals: number; conditions: number; segments: number; vehicle_log: number; alerts_log: number } {
    const one = (t: string) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    return {
      predictions: one("predictions"),
      actuals: one("actuals"),
      conditions: one("conditions"),
      segments: one("segments"),
      vehicle_log: one("vehicle_log"),
      alerts_log: one("alerts_log"),
    };
  }

  // ---- dashboard reads (Phase 4) ----

  /** Snapshot the current accuracy curve per source, so it can be trended. */
  recordAccuracySnapshot(source = "gtfs-rt", now = Math.floor(Date.now() / 1000)): void {
    const buckets = this.accuracyByLeadTime(source);
    this.db.exec("BEGIN");
    try {
      for (const b of buckets) {
        if (b.n > 0) this.insAccSnap.run(now, source, b.leadLabel, b.n, b.maeSec, b.biasSec);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Accuracy over time from the snapshots (for the trend chart). */
  accuracyTrend(source = "gtfs-rt"): { ts: number; leadLabel: string; maeSec: number; n: number }[] {
    return this.db
      .prepare(
        `SELECT ts, lead_label AS leadLabel, mae_sec AS maeSec, n
         FROM accuracy_snapshots WHERE source = ? ORDER BY ts`
      )
      .all(source) as any[];
  }

  /** Distribution of travel time by any one model feature (system-wide). */
  featureStats(feature: string): { value: string; avgTravel: number; n: number }[] {
    const allowed = ["route_id", "from_stop", "to_stop", "hour", "dow", "weather_score", "occ_status"];
    if (!allowed.includes(feature)) return [];
    return this.db
      .prepare(
        `SELECT CAST(${feature} AS TEXT) AS value, ROUND(AVG(travel_sec)) AS avgTravel, COUNT(*) AS n
         FROM segments WHERE ${feature} IS NOT NULL
         GROUP BY ${feature} ORDER BY n DESC LIMIT 40`
      )
      .all() as any[];
  }

  /** Everything known about one trip: its segments + the feed's prediction history. */
  tripHistory(tripId: string): {
    segments: any[];
    predictions: any[];
    actuals: any[];
  } {
    return {
      segments: this.db
        .prepare(
          `SELECT from_stop, to_stop, travel_sec, weather_score, occ_status, hour, dow, arrive_ts
           FROM segments WHERE trip_id = ? ORDER BY arrive_ts`
        )
        .all(tripId) as any[],
      predictions: this.db
        .prepare(
          `SELECT stop_id, pred_arrival, observed_at FROM predictions
           WHERE trip_id = ? ORDER BY observed_at LIMIT 500`
        )
        .all(tripId) as any[],
      actuals: this.db
        .prepare(`SELECT stop_id, actual_arrival FROM actuals WHERE trip_id = ? ORDER BY actual_arrival`)
        .all(tripId) as any[],
    };
  }

  close(): void {
    this.db.close();
  }
}
