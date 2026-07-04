// Rolling 7-day history of vehicle positions, backing the scrub/playback UI.
// Uses Node 24's built-in node:sqlite (no native build). PROJECT_SPEC.md §5.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VehicleState } from "../shared/types.ts";

const RETAIN_SECONDS = 7 * 24 * 3600;

export class History {
  private db: DatabaseSync;
  private insertStmt;

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
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO snapshots (ts, vehicleId, route, dist, speed, shapeId, delay)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /** Persist one tick's worth of states in a single transaction. */
  record(ts: number, states: VehicleState[]): void {
    this.db.exec("BEGIN");
    try {
      for (const s of states) {
        this.insertStmt.run(
          ts,
          s.id,
          s.route,
          s.dist,
          s.speed,
          s.shapeId ?? null,
          s.delay ?? null
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Delete snapshots older than the retention window. Returns rows removed. */
  prune(now = Math.floor(Date.now() / 1000)): number {
    const cutoff = now - RETAIN_SECONDS;
    const r = this.db.prepare("DELETE FROM snapshots WHERE ts < ?").run(cutoff);
    return Number(r.changes ?? 0);
  }

  /** All snapshots at the tick nearest `ts` (for scrub playback). */
  frameAt(ts: number): unknown[] {
    const near = this.db
      .prepare(
        "SELECT ts FROM snapshots ORDER BY ABS(ts - ?) LIMIT 1"
      )
      .get(ts) as { ts?: number } | undefined;
    if (!near?.ts) return [];
    return this.db
      .prepare("SELECT * FROM snapshots WHERE ts = ?")
      .all(near.ts);
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
