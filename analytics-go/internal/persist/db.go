// Package persist is the analytics service's own SQLite store
// (data/analytics.db), separate from the Node server's history.db to avoid
// any two-process concurrent-writer contention. Uses the pure-Go
// modernc.org/sqlite driver (no cgo / no native build toolchain), matching
// the same decision made for node:sqlite over better-sqlite3 on the TS side.
//
// Two tables:
//   baselines      - persisted Welford state per route+direction key, so
//                    anomaly detection is warm on restart instead of cold.
//   anomaly_events - one row per anomaly onset, for future analytics.
// (A third `occupancy` table was REMOVED: the MTA feed's occupancy field is a
// placeholder — EMPTY for 100% of vehicles — so it was dead data end to end.)
package persist

import (
	"database/sql"
	"log"
	"time"

	_ "modernc.org/sqlite"

	"transit-analytics/internal/stats"
)

const (
	anomalyRetentionDays = 30
)

type DB struct {
	db *sql.DB
}

func Open(path string) (*DB, error) {
	sqldb, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	sqldb.SetMaxOpenConns(1) // single-writer; sidesteps SQLITE_BUSY entirely
	schema := `
	CREATE TABLE IF NOT EXISTS baselines (
		key TEXT PRIMARY KEY, n INTEGER, mean REAL, m2 REAL, updated INTEGER
	);

	CREATE TABLE IF NOT EXISTS anomaly_events (
		ts INTEGER NOT NULL, key TEXT, kind TEXT, gapSeconds REAL, zscore REAL
	);
	CREATE INDEX IF NOT EXISTS idx_anom_ts ON anomaly_events(ts);
	`
	if _, err := sqldb.Exec(schema); err != nil {
		return nil, err
	}
	return &DB{db: sqldb}, nil
}

// SaveBaselines upserts every current Welford baseline.
func (d *DB) SaveBaselines(baselines []stats.BaselineState) error {
	if len(baselines) == 0 {
		return nil
	}
	now := time.Now().Unix()
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	for _, b := range baselines {
		_, err := tx.Exec(
			`INSERT INTO baselines (key, n, mean, m2, updated) VALUES (?,?,?,?,?)
			 ON CONFLICT(key) DO UPDATE SET n=excluded.n, mean=excluded.mean, m2=excluded.m2, updated=excluded.updated`,
			b.Key, b.N, b.Mean, b.M2, now)
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// LoadBaselines returns all persisted baselines for startup seeding.
func (d *DB) LoadBaselines() ([]stats.BaselineState, error) {
	rows, err := d.db.Query(`SELECT key, n, mean, m2 FROM baselines`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []stats.BaselineState
	for rows.Next() {
		var b stats.BaselineState
		if err := rows.Scan(&b.Key, &b.N, &b.Mean, &b.M2); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// RecordAnomalyEvents logs anomaly onsets (one row each).
func (d *DB) RecordAnomalyEvents(ts int64, flags []stats.Flag) error {
	if len(flags) == 0 {
		return nil
	}
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	for _, f := range flags {
		if _, err := tx.Exec(
			`INSERT INTO anomaly_events (ts, key, kind, gapSeconds, zscore) VALUES (?,?,?,?,?)`,
			ts, f.Key, f.Kind, f.GapSeconds, f.ZScore); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// Prune drops rows past the retention windows. Baselines are never pruned
// (they're upserted, one row per key).
func (d *DB) Prune() {
	now := time.Now().Unix()
	if _, err := d.db.Exec(`DELETE FROM anomaly_events WHERE ts < ?`, now-int64(anomalyRetentionDays*86400)); err != nil {
		log.Printf("[persist] prune anomaly_events: %v", err)
	}
}

func (d *DB) Close() error { return d.db.Close() }
