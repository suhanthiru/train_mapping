// Bitemporal prediction ledger: records the GTFS-realtime feed's EVOLVING
// arrival predictions (with when-we-knew-them), the eventual ACTUAL arrivals
// (ground truth), and city weather over time — the data foundation for an ETA
// backtest (feed accuracy vs. lead time) and a later ETA model whose features
// are weather + time/route context. Separate DB from history.db so
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
  private getWatermark;
  private setWatermark;
  private prevActual;
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
      -- supports buildSegments()'s incremental predecessor lookup (trip_id +
      -- time-ordered scan); the UNIQUE index above is keyed on stop_id, not
      -- useful for that range query.
      CREATE INDEX IF NOT EXISTS idx_actuals_trip_ts ON actuals(trip_id, actual_arrival);

      CREATE TABLE IF NOT EXISTS segments_watermark (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        last_actual_arrival INTEGER NOT NULL DEFAULT 0
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
      `INSERT INTO predictions (trip_id, stop_id, route_id, pred_arrival, observed_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.insActual = this.db.prepare(
      `INSERT OR IGNORE INTO actuals (trip_id, stop_id, actual_arrival) VALUES (?, ?, ?)`
    );
    this.insCond = this.db.prepare(
      `INSERT INTO conditions (ts, weather_score, temp_f, precipitating, conditions) VALUES (?, ?, ?, ?, ?)`
    );
    this.insModelPred = this.db.prepare(
      `INSERT INTO predictions (trip_id, stop_id, route_id, pred_arrival, observed_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`
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
    this.db.exec(`INSERT OR IGNORE INTO segments_watermark (id, last_actual_arrival) VALUES (1, 0)`);
    this.getWatermark = this.db.prepare(
      `SELECT last_actual_arrival FROM segments_watermark WHERE id = 1`
    );
    this.setWatermark = this.db.prepare(
      `UPDATE segments_watermark SET last_actual_arrival = ? WHERE id = 1`
    );
    // buildSegments()'s per-row predecessor lookup: the actual immediately
    // before `b` for the same trip, regardless of whether it's older than the
    // watermark (already processed) or newly arrived in this same batch —
    // either way it's already a committed row in `actuals` by the time this
    // query runs, so lookup order doesn't matter, only insertion order does.
    this.prevActual = this.db.prepare(
      `SELECT stop_id, actual_arrival FROM actuals
       WHERE trip_id = ? AND actual_arrival < ? ORDER BY actual_arrival DESC LIMIT 1`
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
          this.insPred.run(v.tripId, u.stopId, v.routeId, u.time, v.feedTimestamp);
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
  recordModelPredictions(rows: { tripId: string; stopId: string; routeId: string; predArrival: number; observedAt: number }[], source = "model-v1"): void {
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        // namespace the change-detection key by source so model-v1 and model-v2
        // (or any future version) never collide in the dedup map
        const key = `${source}:${r.tripId}|${r.stopId}`;
        const prev = this.lastPred.get(key);
        if (prev !== undefined && Math.abs(r.predArrival - prev) <= PRED_CHANGE_THRESHOLD_S) {
          continue; // unchanged belief — skip duplicate row
        }
        this.lastPred.set(key, r.predArrival);
        this.insModelPred.run(r.tripId, r.stopId, r.routeId, r.predArrival, r.observedAt, source);
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
   *
   * ROLLING WINDOW + SQL AGGREGATION (both load-bearing, learned the hard way):
   * this used to `.all()` every graded row into JS — 8.6M objects for model-v1
   * (~3 GB) on the SYNCHRONOUS node:sqlite handle, so each call blocked the
   * event loop for seconds and the dashboard's 15s polling ×3 sources OOMed the
   * process (observed live: 3 GB RSS within 20s of boot, HTTP unresponsive —
   * exactly the "compounds silently" failure the incremental-backtest note
   * predicted). Now SQLite aggregates in C and returns ≤5 rows, and the window
   * keeps the scan on idx_pred_observed instead of the whole 30-day table.
   * This makes the live metric "rolling recent accuracy" (default 6h) — the
   * full-history version lives in `npm run report:backtest` (DuckDB, offline),
   * which is the right tool for that question anyway.
   */
  accuracyByLeadTime(source = "gtfs-rt", windowS = 6 * 3600): LeadTimeBucket[] {
    const since = Math.floor(Date.now() / 1000) - windowS;
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN lead < 60 THEN '0-1 min'
                     WHEN lead < 120 THEN '1-2 min'
                     WHEN lead < 300 THEN '2-5 min'
                     WHEN lead < 600 THEN '5-10 min'
                     ELSE '10+ min' END AS leadLabel,
                COUNT(*) AS n,
                AVG(ABS(err)) AS maeSec,
                AVG(err) AS biasSec
         FROM (
           SELECT (a.actual_arrival - p.observed_at) AS lead,
                  (p.pred_arrival - a.actual_arrival) AS err
           FROM predictions p
           JOIN actuals a ON a.trip_id = p.trip_id AND a.stop_id = p.stop_id
           WHERE p.observed_at >= ?
             AND p.source = ?
             AND p.observed_at <= a.actual_arrival
             AND (a.actual_arrival - p.observed_at) BETWEEN 0 AND 1800
         )
         GROUP BY leadLabel`
      )
      .all(since, source) as { leadLabel: string; n: number; maeSec: number; biasSec: number }[];

    const byLabel = new Map(rows.map((r) => [r.leadLabel, r]));
    return ["0-1 min", "1-2 min", "2-5 min", "5-10 min", "10+ min"].map((label) => {
      const r = byLabel.get(label);
      return {
        leadLabel: label,
        n: r?.n ?? 0,
        maeSec: Math.round(r?.maeSec ?? 0),
        biasSec: Math.round(r?.biasSec ?? 0),
      };
    });
  }

  /**
   * Incrementally materialize `segments` from `actuals`: pair each newly-
   * arrived actual with its trip's immediately-preceding actual into a
   * (from_stop -> to_stop) hop with travel time, enriched with nearest
   * weather + local hour/dow. INSERT-only — segments are immutable once a
   * hop completes, so past rows never need to change.
   *
   * Watermark-based: only processes actuals newer than the last run's high
   * watermark (`segments_watermark`), instead of re-reading and re-deriving
   * all of `actuals` from scratch every call. The old version did
   * `DELETE FROM segments` + full rebuild every hour, which meant reprocessing
   * a table that gets strictly larger every day, forever (the exact
   * "compounds silently" pattern already fixed once this session in
   * accuracyByLeadTime()). A fresh ledger starts at watermark 0, so the first
   * call after this change still does a one-time full pass; every call after
   * that only touches what's actually new. Returns rows written this call.
   */
  buildSegments(stopPos?: Record<string, [number, number]>, stopElev?: Record<string, string>): number {
    // idempotent column adds (for ledgers created before Phase 2)
    for (const col of ["distance_m REAL", "elevation TEXT"]) {
      try { this.db.exec(`ALTER TABLE segments ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    const watermark = (this.getWatermark.get() as { last_actual_arrival: number }).last_actual_arrival;
    const newActuals = this.db
      .prepare("SELECT trip_id, stop_id, actual_arrival FROM actuals WHERE actual_arrival > ? ORDER BY actual_arrival")
      .all(watermark) as { trip_id: string; stop_id: string; actual_arrival: number }[];
    if (!newActuals.length) return 0;

    const wxStmt = this.db.prepare(
      "SELECT weather_score FROM conditions WHERE ts <= ? ORDER BY ts DESC LIMIT 1"
    );
    const ins = this.db.prepare(
      `INSERT INTO segments
         (trip_id, route_id, from_stop, to_stop, depart_ts, arrive_ts, travel_sec, weather_score, hour, dow, distance_m, elevation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.exec("BEGIN");
    try {
      let n = 0;
      let maxTs = watermark;
      for (const b of newActuals) {
        if (b.actual_arrival > maxTs) maxTs = b.actual_arrival;
        const a = this.prevActual.get(b.trip_id, b.actual_arrival) as
          | { stop_id: string; actual_arrival: number }
          | undefined;
        if (!a) continue; // first actual seen for this trip — nothing to pair yet
        const travel = b.actual_arrival - a.actual_arrival;
        if (travel < 10 || travel > 1800) continue; // drop bad pairings / long gaps
        // NYC trip_id like "015200_1..N10R" -> route "1"
        const routeId = b.trip_id.split("_")[1]?.split("..")[0] ?? null;
        const wx = wxStmt.get(b.actual_arrival) as { weather_score: number } | undefined;
        const d = new Date(b.actual_arrival * 1000); // local tz (assumed ET on the host)
        const pf = stopPos?.[a.stop_id];
        const pt = stopPos?.[b.stop_id];
        const distance = pf && pt ? Math.round(haversine(pf, pt)) : null;
        const elevation = stopElev?.[b.stop_id] ?? stopElev?.[a.stop_id] ?? null;
        ins.run(
          b.trip_id, routeId, a.stop_id, b.stop_id,
          a.actual_arrival, b.actual_arrival, travel,
          wx?.weather_score ?? null,
          d.getHours(), d.getDay(), distance, elevation
        );
        n++;
      }
      this.setWatermark.run(maxTs);
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

  /** Rows written in the trailing hour — observability: is data still flowing? */
  writeRates(now = Math.floor(Date.now() / 1000)): { predictionsPerHour: number; actualsPerHour: number; vehicleLogPerHour: number } {
    const since = now - 3600;
    const one = (sql: string) => Number((this.db.prepare(sql).get(since) as { c: number }).c);
    return {
      predictionsPerHour: one("SELECT COUNT(*) AS c FROM predictions WHERE observed_at > ?"),
      actualsPerHour: one("SELECT COUNT(*) AS c FROM actuals WHERE actual_arrival > ?"),
      vehicleLogPerHour: one("SELECT COUNT(*) AS c FROM vehicle_log WHERE ts > ?"),
    };
  }

  /**
   * Hourly write counts across the pipeline's key flows for the trailing
   * `hours` hours (default 24) — the uptime view: a live/collecting hour has
   * nonzero feed + vehicleLog; a zero hour means the pipeline wasn't running
   * or the feed was unreachable, not that trains stopped moving.
   */
  hourlyThroughput(hours = 24, now = Math.floor(Date.now() / 1000)): {
    hourStart: number; feed: number; modelV1: number; modelV2: number; actuals: number; vehicleLog: number;
  }[] {
    const since = now - hours * 3600;
    const bucket = (col: string) => `CAST((${now} - ${col}) / 3600 AS INTEGER)`;
    const byHour = (sql: string, param: number | string = since) => {
      const rows = this.db.prepare(sql).all(param) as { h: number; c: number }[];
      const m = new Map<number, number>();
      for (const r of rows) m.set(r.h, r.c);
      return m;
    };
    const feed = byHour(
      `SELECT ${bucket("observed_at")} AS h, COUNT(*) AS c FROM predictions
       WHERE source='gtfs-rt' AND observed_at > ? GROUP BY h`
    );
    const v1 = byHour(
      `SELECT ${bucket("observed_at")} AS h, COUNT(*) AS c FROM predictions
       WHERE source='model-v1' AND observed_at > ? GROUP BY h`
    );
    const v2 = byHour(
      `SELECT ${bucket("observed_at")} AS h, COUNT(*) AS c FROM predictions
       WHERE source='model-v2' AND observed_at > ? GROUP BY h`
    );
    const act = byHour(
      `SELECT ${bucket("actual_arrival")} AS h, COUNT(*) AS c FROM actuals
       WHERE actual_arrival > ? GROUP BY h`
    );
    const vlog = byHour(
      `SELECT ${bucket("ts")} AS h, COUNT(*) AS c FROM vehicle_log
       WHERE ts > ? GROUP BY h`
    );
    const out = [];
    for (let h = hours - 1; h >= 0; h--) {
      out.push({
        hourStart: now - (h + 1) * 3600,
        feed: feed.get(h) ?? 0, modelV1: v1.get(h) ?? 0, modelV2: v2.get(h) ?? 0,
        actuals: act.get(h) ?? 0, vehicleLog: vlog.get(h) ?? 0,
      });
    }
    return out;
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
    const allowed = ["route_id", "from_stop", "to_stop", "hour", "dow", "weather_score", "distance_m", "elevation"];
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
          `SELECT from_stop, to_stop, travel_sec, weather_score, hour, dow, arrive_ts
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

  /**
   * Per-arrival drill-down (Phase 6): the most recent completed arrivals, each
   * with the feed's and the model's LAST prediction before the actual arrival —
   * the case-by-case "estimated ETA vs ATA" view. errSec = pred - actual (+late),
   * leadSec = how far before arrival that final belief was.
   */
  recentArrivalComparisons(limit = 30): any[] {
    const actuals = this.db
      .prepare("SELECT trip_id, stop_id, actual_arrival FROM actuals ORDER BY actual_arrival DESC LIMIT ?")
      .all(limit) as { trip_id: string; stop_id: string; actual_arrival: number }[];
    const last = this.db.prepare(
      `SELECT pred_arrival, observed_at, route_id FROM predictions
       WHERE trip_id = ? AND stop_id = ? AND source = ? AND observed_at <= ?
       ORDER BY observed_at DESC LIMIT 1`
    );
    const side = (r: any, ata: number) =>
      r ? { pred: r.pred_arrival, errSec: r.pred_arrival - ata, leadSec: ata - r.observed_at } : null;
    const out: any[] = [];
    for (const a of actuals) {
      const feed = last.get(a.trip_id, a.stop_id, "gtfs-rt", a.actual_arrival) as any;
      const model = last.get(a.trip_id, a.stop_id, "model-v1", a.actual_arrival) as any;
      if (!feed && !model) continue;
      out.push({
        tripId: a.trip_id,
        stopId: a.stop_id,
        routeId: feed?.route_id ?? model?.route_id ?? null,
        actualArrival: a.actual_arrival,
        feed: side(feed, a.actual_arrival),
        model: side(model, a.actual_arrival),
      });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
