"""Train the ETA model (XGBoost) on the segment-traversal table and export it
for serving. Offline / occasional — run: python analytics-py/train_eta.py.

Label: travel_sec (a segment's actual traversal time). Features: route +
from/to stop + elevation (categorical, label-encoded) + hour + dow +
weather_score + distance_m. Uses polars to load/inspect, numpy+xgboost to train.

NOTE: the roadmap called for ONNX export, but the `onnx` pip package cannot
install on this machine's Store-Python (Windows MAX_PATH on onnx's test-data
paths, needs admin to enable long paths). We export the native XGBoost model
(eta_model.json) and serve it via FastAPI (app.py) instead — same train-heavy /
serve-light shape, minus the ONNX intermediary.

Honest caveat: accuracy is weak until the ledger matures — with a day of data
most segments are seen once, so this mainly stands up the pipeline.
"""
import json
import os
import sqlite3

import numpy as np
import polars as pl
import xgboost as xgb

import mta_ridership

HERE = os.path.dirname(__file__)
# Env-overridable so a container can point at the bind-mounted ledger + a
# persistent model dir (see docker-compose.yml). Defaults keep local dev working.
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))
MODEL_DIR = os.environ.get("MODEL_DIR", HERE)
os.makedirs(MODEL_DIR, exist_ok=True)  # mounted dir may not exist yet on a fresh host
OUT_MODEL = os.path.join(MODEL_DIR, "eta_model.json")
OUT_FEATS = os.path.join(MODEL_DIR, "eta_features.json")
OUT_MODEL_V2 = os.path.join(MODEL_DIR, "eta_model_v2.json")
OUT_FEATS_V2 = os.path.join(MODEL_DIR, "eta_features_v2.json")

# Phase 4: distance_m + elevation added; dead occ_pct dropped.
# Ridership: real station busyness (avg riders/hr at the destination station for
# this hour+dow, from MTA Open Data) — the honest replacement for occupancy.
# Computed in Python at BOTH train and serve time (see app.py), never stored in
# the ledger, so train/serve can't drift. Missing -> 0.0 on both sides.
CAT = ["route_id", "from_stop", "to_stop", "elevation"]
NUM = ["hour", "dow", "weather_score", "distance_m", "ridership"]
FEAT_ORDER = CAT + NUM

# model-v2 (the late-bias fix): label = seconds REMAINING in the current hop
# given how far through it the train already is. Trained on vehicle_log (the
# forward-only Kalman progress logger) joined to ground-truth arrivals — each
# log tick mid-hop becomes one (features + frac_hop -> remaining_sec) example.
# v1 answers "how long is this segment?"; v2 answers "how long is LEFT?".
CAT_V2 = CAT
NUM_V2 = ["hour", "dow", "weather_score", "distance_m", "ridership",
          "frac_hop", "kalman_speed", "trains_ahead"]
FEAT_ORDER_V2 = CAT_V2 + NUM_V2


def train():
    """Train the ETA model from the segments table; returns (mae, n)."""
    con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT route_id, from_stop, to_stop, elevation, hour, dow, weather_score, distance_m, travel_sec "
        "FROM segments WHERE travel_sec IS NOT NULL"
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    con.close()

    if not rows:
        print("[train] no segments yet — run the backend to collect data (npm run "
              "server), let it build segments, then retry.")
        return (None, 0)

    df = pl.DataFrame(rows, infer_schema_length=None)  # scan all rows (mixed null/value cols)
    n = len(rows)
    print(f"[train] {n} segments · {df['route_id'].n_unique()} routes · "
          f"travel_sec mean={df['travel_sec'].mean():.1f}s")

    # deterministic categorical encoders (saved so serving reproduces features)
    encoders = {c: {v: i for i, v in enumerate(sorted({str(r[c]) for r in rows}))}
                for c in CAT}

    # Enrich with station busyness (not a ledger column — computed here from the
    # cached ridership profile, O(1) per row after one bulk fetch). Training can
    # afford the blocking fetch; serving (app.py) never blocks on it.
    mta_ridership.ensure_profile()
    ridership_hits = 0
    for r in rows:
        b = mta_ridership.busyness(r["to_stop"], r["hour"] or 0, r["dow"] or 0)
        if b is not None:
            ridership_hits += 1
        r["ridership"] = b if b is not None else 0.0
    print(f"[train] ridership coverage: {ridership_hits}/{n} rows "
          f"({mta_ridership.status()['profile_keys']} profile keys)")

    X = np.zeros((n, len(FEAT_ORDER)), dtype=np.float32)
    y = np.zeros(n, dtype=np.float32)
    for i, r in enumerate(rows):
        for j, c in enumerate(CAT):
            X[i, j] = encoders[c].get(str(r[c]), -1)
        for j, c in enumerate(NUM):
            v = r[c]
            X[i, len(CAT) + j] = float(v) if v is not None else 0.0
        y[i] = float(r["travel_sec"])

    model = xgb.XGBRegressor(
        n_estimators=150, max_depth=4, learning_rate=0.1,
        subsample=0.9, objective="reg:squarederror",
    )
    model.fit(X, y)

    pred = model.predict(X)
    mae = float(np.mean(np.abs(pred - y)))
    base = float(np.mean(np.abs(y - y.mean())))
    print(f"[train] in-sample MAE={mae:.1f}s vs predict-the-mean {base:.1f}s "
          f"(thin data — improves as the ledger grows)")

    model.save_model(OUT_MODEL)
    imp = model.get_booster().get_score(importance_type="gain")
    imp_named = {FEAT_ORDER[int(k[1:])]: round(v, 2) for k, v in imp.items()}
    with open(OUT_FEATS, "w") as f:
        json.dump({
            "feat_order": FEAT_ORDER, "cat": CAT, "num": NUM,
            "encoders": encoders, "importance": imp_named,
            "n_train": n, "mae": round(mae, 1),
        }, f, indent=2)
    print(f"[train] wrote {OUT_MODEL} + {OUT_FEATS}")
    print(f"[train] feature importance (gain): {imp_named}")
    return (round(mae, 1), n)


def train_v2():
    """Train the remaining-time model from vehicle_log x actuals; returns (mae, n).

    Each vehicle_log tick (trip mid-hop at frac_hop, with Kalman speed +
    congestion) is joined to that trip's ground-truth arrival at the hop's
    to_stop; the label is (actual_arrival - log ts) = seconds remaining.
    Forward-only data: this only grows while the tracker is actually running,
    so early retrains are honest but thin.
    """
    import bisect
    from datetime import datetime

    con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT vl.ts, vl.route AS route_id, vl.from_stop, vl.to_stop, "
        "       vl.frac_hop, vl.kalman_speed, vl.trains_ahead, "
        "       (a.actual_arrival - vl.ts) AS remaining_sec "
        "FROM vehicle_log vl "
        "JOIN actuals a ON a.trip_id = vl.trip_id AND a.stop_id = vl.to_stop "
        "WHERE vl.frac_hop IS NOT NULL "
        "  AND a.actual_arrival > vl.ts "
        "  AND a.actual_arrival - vl.ts BETWEEN 2 AND 1800"
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    # Per-hop static enrichment (distance/elevation) from segments; nearest-
    # before weather from conditions (bisect over the sorted ts list).
    seg = {}
    for f, t, elev, dist in con.execute(
        "SELECT from_stop, to_stop, elevation, distance_m FROM segments "
        "WHERE elevation IS NOT NULL OR distance_m IS NOT NULL"
    ):
        seg[(f, t)] = (elev, dist)
    wx_rows = con.execute("SELECT ts, weather_score FROM conditions ORDER BY ts").fetchall()
    con.close()
    wx_ts = [r[0] for r in wx_rows]

    if not rows:
        print("[train-v2] no vehicle_log x actuals pairs yet — the forward-only "
              "logger needs runtime; retry after the tracker has run a while.")
        return (None, 0)

    mta_ridership.ensure_profile()
    for r in rows:
        d = datetime.fromtimestamp(r["ts"])  # local tz — same convention as buildSegments
        r["hour"], r["dow"] = d.hour, (d.weekday() + 1) % 7  # weekday(): 0=Mon -> 0=Sun
        elev, dist = seg.get((r["from_stop"], r["to_stop"]), (None, None))
        r["elevation"], r["distance_m"] = elev, dist
        i = bisect.bisect_right(wx_ts, r["ts"]) - 1
        r["weather_score"] = wx_rows[i][1] if i >= 0 else None
        b = mta_ridership.busyness(r["to_stop"], r["hour"], r["dow"])
        r["ridership"] = b if b is not None else 0.0

    n = len(rows)
    print(f"[train-v2] {n} mid-hop samples "
          f"(median remaining {sorted(r['remaining_sec'] for r in rows)[n // 2]}s)")

    encoders = {c: {v: i for i, v in enumerate(sorted({str(r[c]) for r in rows}))}
                for c in CAT_V2}
    X = np.zeros((n, len(FEAT_ORDER_V2)), dtype=np.float32)
    y = np.zeros(n, dtype=np.float32)
    for i, r in enumerate(rows):
        for j, c in enumerate(CAT_V2):
            X[i, j] = encoders[c].get(str(r[c]), -1)
        for j, c in enumerate(NUM_V2):
            v = r[c]
            X[i, len(CAT_V2) + j] = float(v) if v is not None else 0.0
        y[i] = float(r["remaining_sec"])

    model = xgb.XGBRegressor(
        n_estimators=150, max_depth=4, learning_rate=0.1,
        subsample=0.9, objective="reg:squarederror",
    )
    model.fit(X, y)

    pred = model.predict(X)
    mae = float(np.mean(np.abs(pred - y)))
    base = float(np.mean(np.abs(y - y.mean())))
    print(f"[train-v2] in-sample MAE={mae:.1f}s vs predict-the-mean {base:.1f}s")

    model.save_model(OUT_MODEL_V2)
    imp = model.get_booster().get_score(importance_type="gain")
    imp_named = {FEAT_ORDER_V2[int(k[1:])]: round(v, 2) for k, v in imp.items()}
    with open(OUT_FEATS_V2, "w") as f:
        json.dump({
            "feat_order": FEAT_ORDER_V2, "cat": CAT_V2, "num": NUM_V2,
            "encoders": encoders, "importance": imp_named,
            "n_train": n, "mae": round(mae, 1), "label": "remaining_sec",
        }, f, indent=2)
    print(f"[train-v2] wrote {OUT_MODEL_V2} + {OUT_FEATS_V2}")
    print(f"[train-v2] feature importance (gain): {imp_named}")
    return (round(mae, 1), n)


if __name__ == "__main__":
    train()
    train_v2()
