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
import bisect
import json
import os
import sqlite3

import numpy as np
import polars as pl
import xgboost as xgb

import alert_index
import featurize
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

# Feature lists come from THE registry (shared/features.json via
# featurize.feature_spec(), roadmap P5) — adding a feature edits the JSON +
# the producers' enrichment, not five hardcoded lists. Semantics unchanged:
# ridership = real station busyness (occupancy replacement, computed at BOTH
# train and serve time so they can't drift, missing -> 0.0); alert_active =
# service alert near this observation (see alert_index.py).
_SPEC = featurize.feature_spec()
CAT = list(_SPEC["cat"])
NUM = list(_SPEC["num"])
FEAT_ORDER = CAT + NUM

# model-v2 (the late-bias fix): label = seconds REMAINING in the current hop
# given how far through it the train already is. Trained on vehicle_log (the
# forward-only Kalman progress logger) joined to ground-truth arrivals — each
# log tick mid-hop becomes one (features + frac_hop -> remaining_sec) example.
# v1 answers "how long is this segment?"; v2 answers "how long is LEFT?".
CAT_V2 = CAT
NUM_V2 = NUM + list(_SPEC["v2_extra_num"])
FEAT_ORDER_V2 = CAT_V2 + NUM_V2

# Opt-in historical pretraining (default OFF so the existing behaviour is
# unchanged). When PRETRAIN_HISTORY=1, train()/train_v2() blend down-weighted
# synthetic rows from MTA Open Data (build_pretrain.py) with the live ledger to
# cover cold-start hops, and merge years of Service-Alert history into the
# alert_active index. Measure-first: eval_pretrain.py decides whether a blended
# candidate model actually beats the current one before anything is promoted.
PRETRAIN_HISTORY = os.environ.get("PRETRAIN_HISTORY") == "1"
PRETRAIN_WEIGHT = float(os.environ.get("PRETRAIN_WEIGHT", "0.3"))  # synthetic vs real=1.0


# Alert-active lives in alert_index.py (roadmap P3 — one index, named windows).
# These thin wrappers keep the historical call sites/signatures stable.
def _load_alert_index(con, with_history=False):
    return alert_index.build(con, with_history=with_history)


def _alert_active(idx, route_id, ts) -> float:
    return alert_index.active(idx, route_id, ts, window=alert_index.TRAIN_WINDOW_S)


def train():
    """Train the ETA model from the segments table; returns (mae, n)."""
    con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT route_id, from_stop, to_stop, elevation, hour, dow, weather_score, distance_m, arrive_ts, travel_sec "
        "FROM segments WHERE travel_sec IS NOT NULL"
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    alert_index = _load_alert_index(con, with_history=PRETRAIN_HISTORY)
    con.close()

    if not rows:
        print("[train] no segments yet — run the backend to collect data (npm run "
              "server), let it build segments, then retry.")
        return (None, 0)

    df = pl.DataFrame(rows, infer_schema_length=None)  # scan all rows (mixed null/value cols)
    n = len(rows)
    print(f"[train] {n} segments · {df['route_id'].n_unique()} routes · "
          f"travel_sec mean={df['travel_sec'].mean():.1f}s")

    # Enrich real rows with station busyness (not a ledger column — computed here
    # from the cached ridership profile, O(1) per row after one bulk fetch).
    # Training can afford the blocking fetch; serving (app.py) never blocks on it.
    mta_ridership.ensure_profile()
    ridership_hits = 0
    alert_hits = 0
    for r in rows:
        b = mta_ridership.busyness(r["to_stop"], r["hour"] or 0, r["dow"] or 0)
        if b is not None:
            ridership_hits += 1
        r["ridership"] = b if b is not None else 0.0
        r["alert_active"] = _alert_active(alert_index, r["route_id"], r["arrive_ts"])
        alert_hits += r["alert_active"]
    print(f"[train] ridership coverage: {ridership_hits}/{n} rows "
          f"({mta_ridership.status()['profile_keys']} profile keys)")
    print(f"[train] alert_active coverage: {int(alert_hits)}/{n} rows had an active alert")

    # Blend down-weighted synthetic history (opt-in). Real rows weight 1.0;
    # synthetic weight PRETRAIN_WEIGHT so they fill cold-start gaps without
    # drowning the rich near-term ledger signal.
    all_rows = rows
    weights = [1.0] * n
    if PRETRAIN_HISTORY:
        import build_pretrain
        syn, _, st = build_pretrain.load()
        print(f"[train] pretrain blend: +{len(syn)} synthetic v1 rows "
              f"(id_align={st['id_align_frac']}, weight={PRETRAIN_WEIGHT})")
        all_rows = rows + syn
        weights = weights + [PRETRAIN_WEIGHT] * len(syn)

    # deterministic categorical encoders over the UNION (so synthetic + live
    # vocabularies align; saved so serving reproduces features). Encoding goes
    # through featurize.py — the same path app.py serves with, so the two
    # cannot drift (pinned by tests/test_featurize_parity.py).
    encoders = featurize.build_encoders(all_rows, CAT)
    X = featurize.encode_rows(all_rows, FEAT_ORDER, encoders)
    y = featurize.labels(all_rows, "travel_sec")
    sw = np.array(weights, dtype=np.float32)

    model = xgb.XGBRegressor(
        n_estimators=150, max_depth=4, learning_rate=0.1,
        subsample=0.9, objective="reg:squarederror",
    )
    model.fit(X, y, sample_weight=sw)

    pred = model.predict(X[:n])  # report MAE over REAL rows only (comparable across runs)
    mae = float(np.mean(np.abs(pred - y[:n])))
    base = float(np.mean(np.abs(y[:n] - y[:n].mean())))
    print(f"[train] in-sample MAE={mae:.1f}s vs predict-the-mean {base:.1f}s "
          f"({'+history blend' if PRETRAIN_HISTORY else 'ledger only'})")

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


def load_v2_instances(con=None):
    """The v2 training/experiment instance set: each vehicle_log tick (a trip
    mid-hop at frac_hop, with Kalman speed + congestion) joined to that trip's
    ground-truth arrival at the hop's to_stop, enriched with the same features
    v2 trains on. Returns a list of dicts, each carrying every FEAT_ORDER_V2
    feature plus `ts`, `trip_id`, and the label `remaining_sec`.

    SINGLE SOURCE OF TRUTH: train_v2() and the graph experiment (graph_dataset.py)
    both call this, so the graph's node features and residual baseline can never
    drift from what v2 was actually trained on. Forward-only data — grows only
    while the tracker runs.
    """
    from datetime import datetime

    own = con is None
    if own:
        con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT vl.ts, vl.trip_id, vl.route AS route_id, vl.from_stop, vl.to_stop, "
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
    alert_index = _load_alert_index(con, with_history=PRETRAIN_HISTORY)
    if own:
        con.close()
    wx_ts = [r[0] for r in wx_rows]

    if not rows:
        return rows

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
        r["alert_active"] = _alert_active(alert_index, r["route_id"], r["ts"])
    return rows


def train_v2():
    """Train the remaining-time model from vehicle_log x actuals; returns (mae, n).
    Feature loading is shared with the graph experiment via load_v2_instances().
    """
    rows = load_v2_instances()

    if not rows:
        print("[train-v2] no vehicle_log x actuals pairs yet — the forward-only "
              "logger needs runtime; retry after the tracker has run a while.")
        return (None, 0)

    n = len(rows)
    alert_hits = sum(r["alert_active"] for r in rows)
    print(f"[train-v2] {n} mid-hop samples "
          f"(median remaining {sorted(r['remaining_sec'] for r in rows)[n // 2]}s, "
          f"{int(alert_hits)} with an active alert)")

    # Blend down-weighted synthetic mid-hop rows (opt-in). NB: a single subway
    # hop is ~2 min, so synthetic normal-service rows reinforce near/mid-term;
    # the truly starved 5-10/10+ min remaining buckets are disruption-driven and
    # are the anomaly detector's job — measure-first (eval_pretrain.py) verifies
    # the blend doesn't regress the near-term v2 buckets before promotion.
    all_rows = rows
    weights = [1.0] * n
    if PRETRAIN_HISTORY:
        import build_pretrain
        _, syn, st = build_pretrain.load()
        print(f"[train-v2] pretrain blend: +{len(syn)} synthetic v2 rows "
              f"(weight={PRETRAIN_WEIGHT})")
        all_rows = rows + syn
        weights = weights + [PRETRAIN_WEIGHT] * len(syn)

    encoders = featurize.build_encoders(all_rows, CAT_V2)
    X = featurize.encode_rows(all_rows, FEAT_ORDER_V2, encoders)
    y = featurize.labels(all_rows, "remaining_sec")
    sw = np.array(weights, dtype=np.float32)

    model = xgb.XGBRegressor(
        n_estimators=150, max_depth=4, learning_rate=0.1,
        subsample=0.9, objective="reg:squarederror",
    )
    model.fit(X, y, sample_weight=sw)

    pred = model.predict(X[:n])  # MAE over REAL rows only (comparable across runs)
    mae = float(np.mean(np.abs(pred - y[:n])))
    base = float(np.mean(np.abs(y[:n] - y[:n].mean())))
    print(f"[train-v2] in-sample MAE={mae:.1f}s vs predict-the-mean {base:.1f}s "
          f"({'+history blend' if PRETRAIN_HISTORY else 'ledger only'})")

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
