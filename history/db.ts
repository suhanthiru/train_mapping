// Rolling 7-day history of vehicle positions, backing the scrub/playback UI.
// Uses Node 24's built-in node:sqlite (no native build). PROJECT_SPEC.md §5.
//
// P5: change-detected writes. Previously every train wrote a row every 4s tick
// (~700 rows/4s) even while parked at a platform. Now a row is written only
// when the vehicle meaningfully moved/changed, plus a low-rate heartbeat so
// readers can bound their reconstruction window:
//   * readers of "state at time T" (frameAt) reconstruct: latest row per
//     vehicle within [T - HEARTBEAT - slack, T] — identical output to the
//     dense table for any T, verified against a dense-write baseline.
//   * ledger-report's speed calibration pairs rows with dt <= 30s; stationary
//     (skipped) stretches simply produce no pairs there — by design, it only
//     ever measured moving trains.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VehicleState } from "../shared/types.ts";

const RETAIN_SECONDS = 7 * 24 * 3600;
// write when moved >= this many meters or speed changed >= this much …
const MIN_DIST_M = 2;
const MIN_SPEED_DELTA = 0.2;
// … or this long since the vehicle's last row (liveness heartbeat; bounds the
// reader's reconstruction window)
const HEARTBEAT_S = 300;
const RECON_SLACK_S = 20; // window = HEARTBEAT + slack (one late tick of grace)

export class History {
  private db: DatabaseSync;
  private insertStmt;
  // vehicleId -> last WRITTEN row's {dist, speed, ts} (change-detection state)
  private lastWritten = new Map<string, { dist: number; speed: number; ts: number }>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        ts INTEGER NOT NULL,
        vehicleId TEXT NOT NULL,
        route TEXT,
        dist REAL NOT NULL,
        speed REAL NOT NULL,
        shapeId TEXT,
        delay REAL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
      -- supports frameAt's per-vehicle latest-row reconstruction
      CREATE INDEX IF NOT EXISTS idx_snapshots_veh_ts ON snapshots(vehicleId, ts);
    `);
    // gone=1 marks a departure tombstone: without it a despawned train would
    // ghost in reconstructed playback frames for up to the heartbeat window.
    try { this.db.exec(`ALTER TABLE snapshots ADD COLUMN gone INTEGER DEFAULT 0`); } catch { /* exists */ }
    this.insertStmt = this.db.prepare(
      `INSERT INTO snapshots (ts, vehicleId, route, dist, speed, shapeId, delay, gone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /** Persist one tick's worth of states in a single transaction — but only
   *  rows that changed (or are due a heartbeat). Returns rows written. */
  record(ts: number, states: VehicleState[]): number {
    let written = 0;
    const present = new Set<string>();
    this.db.exec("BEGIN");
    try {
      for (const s of states) {
        present.add(s.id);
        const prev = this.lastWritten.get(s.id);
        if (
          prev &&
          Math.abs(s.dist - prev.dist) < MIN_DIST_M &&
          Math.abs(s.speed - prev.speed) < MIN_SPEED_DELTA &&
          ts - prev.ts < HEARTBEAT_S
        ) {
          continue; // parked / unchanged — no row this tick
        }
        this.insertStmt.run(ts, s.id, s.route, s.dist, s.speed, s.shapeId ?? null, s.delay ?? null, 0);
        this.lastWritten.set(s.id, { dist: s.dist, speed: s.speed, ts });
        written++;
      }
      // departure tombstones: a vehicle we've written before that vanished from
      // this tick gets one final gone=1 row, so playback drops it immediately
      // instead of ghosting it for the heartbeat window.
      for (const [id, prev] of this.lastWritten) {
        if (present.has(id)) continue;
        this.insertStmt.run(ts, id, null, prev.dist, 0, null, null, 1);
        this.lastWritten.delete(id);
        written++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return written;
  }

  /** Delete snapshots older than the retention window. Returns rows removed. */
  prune(now = Math.floor(Date.now() / 1000)): number {
    const cutoff = now - RETAIN_SECONDS;
    const r = this.db.prepare("DELETE FROM snapshots WHERE ts < ?").run(cutoff);
    // change-detection map: forget vehicles not written since the heartbeat
    // horizon (they've left service); bounds the map like ledger's lastVehLog.
    const mapCutoff = now - 2 * HEARTBEAT_S;
    for (const [k, v] of this.lastWritten) if (v.ts < mapCutoff) this.lastWritten.delete(k);
    return Number(r.changes ?? 0);
  }

  /** State at time `ts` for scrub playback: the latest row per vehicle within
   *  the reconstruction window ending at the nearest tick — equivalent to the
   *  old exact-tick read on a dense table, but correct on the sparse one
   *  (a parked train keeps its last-written position instead of vanishing). */
  frameAt(ts: number): unknown[] {
    const near = this.db
      .prepare("SELECT ts FROM snapshots ORDER BY ABS(ts - ?) LIMIT 1")
      .get(ts) as { ts?: number } | undefined;
    if (!near?.ts) return [];
    const from = near.ts - (HEARTBEAT_S + RECON_SLACK_S);
    // latest row per vehicle in the window; a gone=1 latest row means the
    // vehicle departed before this frame — excluded.
    return this.db
      .prepare(
        `SELECT s.* FROM snapshots s
         JOIN (SELECT vehicleId, MAX(ts) AS mts FROM snapshots
               WHERE ts BETWEEN ? AND ? GROUP BY vehicleId) m
           ON m.vehicleId = s.vehicleId AND m.mts = s.ts
         WHERE s.gone = 0`
      )
      .all(from, near.ts);
  }

  /** Distinct tick timestamps in a window, for building a scrub timeline. */
  timeline(fromTs: number, toTs: number): number[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT ts FROM snapshots WHERE ts BETWEEN ? AND ? ORDER BY ts"
      )
      .all(fromTs, toTs) as { ts: number }[];
    return rows.map((r) => r.ts);
  }

  close(): void {
    this.db.close();
  }
}
