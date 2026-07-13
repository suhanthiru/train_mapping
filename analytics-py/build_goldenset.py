"""Build the GOLDEN SET: one frozen row per completed arrival, joining the
backfillable features (from `segments`) with the feed's ETAs at 10/5/1 min
before arrival and the forward-only signals (Kalman progress, congestion,
alerts) as-of those leads, plus the ATA (ground truth). Written to Parquet so
every future experimental model trains/tests on the IDENTICAL, prune-immune
dataset — the closed environment for feature A/B experiments.

Run: python analytics-py/build_goldenset.py  (or on the auto-retrain schedule)
"""
import os
import sqlite3
from datetime import datetime, timezone

import polars as pl

import alert_index
import mta_ridership

HERE = os.path.dirname(__file__)
# Env-overridable to match the container's bind mounts (see docker-compose.yml).
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))
OUTDIR = os.environ.get("GOLDENSET_DIR", os.path.join(HERE, "..", "data", "exports", "goldenset"))


def main():
    con = sqlite3.connect(LEDGER)
    cur = con.cursor()
    segs = cur.execute(
        "SELECT trip_id, route_id, from_stop, to_stop, arrive_ts, travel_sec, "
        "distance_m, elevation, hour, dow, weather_score FROM segments "
        "WHERE arrive_ts IS NOT NULL"
    ).fetchall()
    cols = [d[0] for d in cur.description]

    def feed_eta(trip, stop, before_ts):
        r = cur.execute(
            "SELECT pred_arrival FROM predictions WHERE trip_id=? AND stop_id=? "
            "AND source='gtfs-rt' AND observed_at<=? ORDER BY observed_at DESC LIMIT 1",
            (trip, stop, before_ts),
        ).fetchone()
        return r[0] if r else None

    def vlog(trip, ts):
        r = cur.execute(
            "SELECT frac_hop, trains_ahead FROM vehicle_log WHERE trip_id=? AND ts<=? "
            "ORDER BY ts DESC LIMIT 1",
            (trip, ts),
        ).fetchone()
        return (r[0], r[1]) if r else (None, None)

    # alert_active via the shared index (P3) — one bisect index instead of one
    # SQL COUNT round-trip per row; same TRAIN_WINDOW_S the live model trains with.
    aidx = alert_index.build(con)

    def alert_active(route, ts):
        return int(alert_index.active(aidx, route, ts, window=alert_index.TRAIN_WINDOW_S))

    # Ridership is NOT a stored per-observation column — it's a static busyness
    # profile keyed on (station, hour, dow). train_eta.py joins it at train time,
    # so the golden set was previously blind to the feature the live model uses.
    # Join it here too (same busyness() call) so golden-set A/B analysis sees it.
    mta_ridership.ensure_profile()

    rows = []
    for s in segs:
        d = dict(zip(cols, s))
        ata, trip, to, route = d["arrive_ts"], d["trip_id"], d["to_stop"], d["route_id"]
        d["ata"] = ata
        d["feed_eta_10min"] = feed_eta(trip, to, ata - 600)
        d["feed_eta_5min"] = feed_eta(trip, to, ata - 300)
        d["feed_eta_1min"] = feed_eta(trip, to, ata - 60)
        for lead, col in ((600, "feed_err_10min"), (300, "feed_err_5min"), (60, "feed_err_1min")):
            k = {"600": "feed_eta_10min", "300": "feed_eta_5min", "60": "feed_eta_1min"}[str(lead)]
            d[col] = (d[k] - ata) if d[k] is not None else None
        fr, ah = vlog(trip, ata - 300)  # forward-only, as-of ~5 min out
        d["frac_hop_5min"], d["trains_ahead_5min"] = fr, ah
        d["direction"] = to[-1] if to and to[-1] in "NS" else ""
        d["alert_active"] = alert_active(route, ata)
        b = mta_ridership.busyness(to, d["hour"] or 0, d["dow"] or 0)
        d["ridership"] = b if b is not None else 0.0
        rows.append(d)
    con.close()

    if not rows:
        print("[goldenset] no segments yet — collect data first.")
        return

    df = pl.DataFrame(rows, infer_schema_length=None)
    os.makedirs(OUTDIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    path = os.path.join(OUTDIR, f"goldenset_{stamp}.parquet")
    df.write_parquet(path)
    have_feed = df.filter(pl.col("feed_eta_5min").is_not_null()).height
    print(f"[goldenset] wrote {len(rows)} rows ({have_feed} with a 5-min feed ETA) -> {path}")
    print(f"[goldenset] columns: {df.columns}")


if __name__ == "__main__":
    main()
