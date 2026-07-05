"""Train the ETA model (XGBoost) on the segment-traversal table and export it
for serving. Offline / occasional — run: python analytics-py/train_eta.py.

Label: travel_sec (a segment's actual traversal time). Features: route +
from/to stop (categorical, label-encoded) + hour + dow + weather_score +
occ_pct. Uses polars to load/inspect, numpy+xgboost to train.

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

HERE = os.path.dirname(__file__)
LEDGER = os.path.join(HERE, "..", "data", "ledger.db")
OUT_MODEL = os.path.join(HERE, "eta_model.json")
OUT_FEATS = os.path.join(HERE, "eta_features.json")

CAT = ["route_id", "from_stop", "to_stop"]
NUM = ["hour", "dow", "weather_score", "occ_pct"]
FEAT_ORDER = CAT + NUM


def main():
    con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT route_id, from_stop, to_stop, hour, dow, weather_score, occ_pct, travel_sec "
        "FROM segments WHERE travel_sec IS NOT NULL"
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    con.close()

    if not rows:
        print("[train] no segments yet — run the backend to collect data (npm run "
              "server), let it build segments, then retry.")
        return

    df = pl.DataFrame(rows)  # polars for a quick sanity read
    n = len(rows)
    print(f"[train] {n} segments · {df['route_id'].n_unique()} routes · "
          f"travel_sec mean={df['travel_sec'].mean():.1f}s")

    # deterministic categorical encoders (saved so serving reproduces features)
    encoders = {c: {v: i for i, v in enumerate(sorted({str(r[c]) for r in rows}))}
                for c in CAT}

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


if __name__ == "__main__":
    main()
