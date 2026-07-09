#!/usr/bin/env bash
# Daily backup for the always-on host. Run via cron (see crontab line below).
#
# Backs up:
#   - data/ledger.db   (the actual asset — predictions, actuals, segments,
#                        vehicle_log; everything the ETA models train on)
#   - data/exports/goldenset/  (frozen Parquet snapshots — already prune-immune,
#                        but cheap insurance against a host-level disk loss)
#
# Deliberately SKIPS:
#   - data/history.db  (7-day rolling position cache — ephemeral, re-populates
#                        from the live feed, not worth the disk/bandwidth)
#   - data/nyc/         (static GTFS geometry — regenerable via `npm run
#                        preprocess:nyc`, checked into no backup either)
#   - data/analytics.db (Go service's own baselines/anomaly log — small,
#                        add it below if you want it too)
#
# Uses SQLite's online .backup (via the sqlite3 CLI) rather than `cp`, which
# is safe to run against a live database the backend is actively writing to —
# a raw file copy of an open SQLite db can capture a half-written page.
#
# Usage: install sqlite3 (`sudo apt install sqlite3`), then:
#   chmod +x infra/backup.sh
#   ./infra/backup.sh                 # run once manually to test
# Crontab (daily at 3am, keep 14 days):
#   0 3 * * * /path/to/train_tracker/infra/backup.sh >> /var/log/train-tracker-backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_DIR/data"
BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

echo "[backup] $STAMP starting"

# --- ledger.db: online backup (safe against a live writer), then compress ---
if [ -f "$DATA_DIR/ledger.db" ]; then
  TMP="$BACKUP_DIR/ledger_${STAMP}.db"
  sqlite3 "$DATA_DIR/ledger.db" ".backup '$TMP'"
  gzip -f "$TMP"
  SIZE=$(du -h "$TMP.gz" | cut -f1)
  echo "[backup] ledger.db -> ledger_${STAMP}.db.gz ($SIZE)"
else
  echo "[backup] WARNING: $DATA_DIR/ledger.db not found, skipping"
fi

# --- golden-set Parquet snapshots: tar the whole dir (small, already compressed) ---
if [ -d "$DATA_DIR/exports/goldenset" ]; then
  tar -czf "$BACKUP_DIR/goldenset_${STAMP}.tar.gz" -C "$DATA_DIR/exports" goldenset
  SIZE=$(du -h "$BACKUP_DIR/goldenset_${STAMP}.tar.gz" | cut -f1)
  echo "[backup] goldenset/ -> goldenset_${STAMP}.tar.gz ($SIZE)"
fi

# --- rotate: delete backups older than RETENTION_DAYS ---
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name "ledger_*.db.gz" -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
DELETED2=$(find "$BACKUP_DIR" -maxdepth 1 -name "goldenset_*.tar.gz" -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
echo "[backup] pruned $((DELETED + DELETED2)) backup(s) older than ${RETENTION_DAYS}d"

TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[backup] done — $BACKUP_DIR now $TOTAL total"

# --- optional: sync off-host (uncomment + configure if you want off-VM copies,
# e.g. via rclone to Backblaze B2 / S3 / another host — cheap insurance
# against losing the VM itself, not just a disk). Not enabled by default to
# keep this script dependency-free. ---
# rclone sync "$BACKUP_DIR" remote:train-tracker-backups --min-age 1h
