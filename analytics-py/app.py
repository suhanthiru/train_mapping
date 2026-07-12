"""FastAPI serving for analytics-py (roadmap Phase 3): the XGBoost ETA model
(/predict, /feature-importance) plus the existing weather/311 context endpoints
(/context, /weather-score), so this one service replaces the stdlib server.py.

Run: python analytics-py/app.py   (uvicorn on :8091, auto-docs at /docs)

Serves the native XGBoost model — ONNX was planned but its package won't install
on this machine's Store-Python (Windows MAX_PATH). FastAPI + xgboost still gives
the train-heavy / serve-light shape and a typed, auto-documented /predict API.
"""
import json
import os
import threading
import time
from typing import Optional

import numpy as np
import xgboost as xgb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import weather
import nyc311
import mta_ridership
import active_alerts
import train_eta
import build_goldenset

RETRAIN_EVERY_S = 6 * 3600  # continuous retraining cadence

HERE = os.path.dirname(__file__)
# MODEL_DIR lets a container mount a persistent directory for the trained model
# (default: alongside the code, for local dev). Without this, a container restart
# drops eta_model.json and /predict 503s until the next 6h retrain — the "always-
# on host" persistence bug. In Docker it's set to a bind-mounted /data/models.
MODEL_DIR = os.environ.get("MODEL_DIR", HERE)
MODEL_PATH = os.path.join(MODEL_DIR, "eta_model.json")
FEATS_PATH = os.path.join(MODEL_DIR, "eta_features.json")
MODEL_V2_PATH = os.path.join(MODEL_DIR, "eta_model_v2.json")
FEATS_V2_PATH = os.path.join(MODEL_DIR, "eta_features_v2.json")

app = FastAPI(title="transit-analytics", version="0.2.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_model: Optional[xgb.XGBRegressor] = None
_feats: Optional[dict] = None
_model_v2: Optional[xgb.XGBRegressor] = None
_feats_v2: Optional[dict] = None


def load_model():
    global _model, _feats, _model_v2, _feats_v2
    if os.path.exists(MODEL_PATH) and os.path.exists(FEATS_PATH):
        m = xgb.XGBRegressor()
        m.load_model(MODEL_PATH)
        _model = m
        with open(FEATS_PATH) as f:
            _feats = json.load(f)
    if os.path.exists(MODEL_V2_PATH) and os.path.exists(FEATS_V2_PATH):
        m2 = xgb.XGBRegressor()
        m2.load_model(MODEL_V2_PATH)
        _model_v2 = m2
        with open(FEATS_V2_PATH) as f:
            _feats_v2 = json.load(f)


load_model()

# --- continuous retraining (Phase 5): retrain from the growing ledger, hot-reload
# the model with no downtime, and snapshot the golden set. Runs on a daemon timer
# + on demand via POST /retrain. ---
_model_status = {"last_trained": None, "mae": None, "n_train": None,
                 "v2_mae": None, "v2_n_train": None}


def do_retrain():
    global _model_status
    try:
        mae, n = train_eta.train()
        # v2 (remaining-time) trains from vehicle_log x actuals — guarded so a
        # thin/empty forward-only log never blocks the v1 retrain.
        v2_mae, v2_n = None, 0
        try:
            v2_mae, v2_n = train_eta.train_v2()
        except Exception as e:
            print("[retrain] v2 skipped:", e)
        load_model()  # hot-reload the freshly-written models — no restart
        _model_status = {"last_trained": int(time.time()), "mae": mae, "n_train": n,
                         "v2_mae": v2_mae, "v2_n_train": v2_n}
        try:
            build_goldenset.main()  # refresh the frozen experimentation dataset
        except Exception as e:
            print("[retrain] goldenset snapshot skipped:", e)
        print(f"[retrain] done: v1 mae={mae}s n={n} | v2 mae={v2_mae}s n={v2_n}")
        return True
    except Exception as e:
        print("[retrain] failed:", e)
        return False


def _scheduler():
    # Anchor the cadence to the model file's own mtime (I10) instead of always
    # sleeping a fresh RETRAIN_EVERY_S from process start. MODEL_PATH already
    # survives restarts via MODEL_DIR's persistent volume (I2), so its mtime is
    # a durable "last trained" marker for free -- no new state file needed. A
    # host that restarts more often than the retrain cadence was previously
    # never reaching a real 6h cycle: this catches up immediately if the model
    # is already overdue, then falls into the normal interval.
    if os.path.exists(MODEL_PATH):
        remaining = RETRAIN_EVERY_S - (time.time() - os.path.getmtime(MODEL_PATH))
        if remaining > 0:
            time.sleep(remaining)
        else:
            do_retrain()
    while True:
        time.sleep(RETRAIN_EVERY_S)
        do_retrain()


threading.Thread(target=_scheduler, daemon=True).start()


@app.get("/health")
def health():
    # Prefer this process's retrain stats; fall back to the loaded model files'
    # metadata so a fresh process doesn't misreport a 263k-row model as "0".
    s = dict(_model_status)
    if s.get("n_train") is None and _feats:
        s["n_train"], s["mae"] = _feats.get("n_train"), _feats.get("mae")
    if s.get("v2_n_train") is None and _feats_v2:
        s["v2_n_train"], s["v2_mae"] = _feats_v2.get("n_train"), _feats_v2.get("mae")
    return {"ok": True, "model_loaded": _model is not None,
            "model_v2_loaded": _model_v2 is not None,
            "ridership": mta_ridership.status(),
            "alerts": active_alerts.status(), **s}


@app.post("/retrain")
def retrain():
    ok = do_retrain()
    return {"ok": ok, **_model_status}


@app.get("/context")
def context(routeId: str = "", lat: Optional[float] = None, lon: Optional[float] = None):
    cond = weather.get_current_conditions()
    complaints = nyc311.count_near(lat, lon) if (lat is not None and lon is not None) else 0
    parts = []
    if cond.get("precipitating"):
        parts.append(f"active {cond.get('conditions', 'precipitation').lower()} in the area")
    elif cond.get("conditions"):
        parts.append(f"conditions: {cond['conditions'].lower()}")
    if complaints > 0:
        parts.append(f"{complaints} bus-stop-shelter complaint(s) filed nearby in the last 72h")
    why = "; ".join(parts) if parts else "no weather or nearby 311 signal available"
    return {"routeId": routeId, "weather": cond, "nearby311Count": complaints, "why": why}


@app.get("/ridership")
def ridership(stop_id: str, hour: int = 12, dow: int = 1):
    """Station busyness (avg riders/hr) for a stop at (hour, dow) — the model's
    occupancy replacement, exposed for the dashboard + debugging."""
    return {
        "stop_id": stop_id, "hour": hour, "dow": dow,
        "avg_riders_per_hour": mta_ridership.busyness(stop_id, hour, dow),
        **mta_ridership.status(),
    }


@app.get("/weather-score")
def weather_score():
    cond = weather.get_current_conditions()
    return {
        "severity": weather.severity_score(cond),
        "tempF": cond.get("tempF"),
        "precipitating": bool(cond.get("precipitating")),
        "conditions": cond.get("conditions"),
    }


@app.get("/feature-importance")
def feature_importance():
    if not _feats:
        return JSONResponse({"error": "model not trained yet"}, status_code=503)
    out = {
        "importance": _feats.get("importance", {}),
        "n_train": _feats.get("n_train"),
        "mae": _feats.get("mae"),
        "feat_order": _feats.get("feat_order"),
    }
    if _feats_v2:  # v2 alongside, when trained — the dashboard shows both
        out["v2"] = {
            "importance": _feats_v2.get("importance", {}),
            "n_train": _feats_v2.get("n_train"),
            "mae": _feats_v2.get("mae"),
            "feat_order": _feats_v2.get("feat_order"),
        }
    return out


# Feature rows are built from the SAVED feat_order (eta_features.json), not a
# hardcoded list — so serving works with models trained before AND after the
# ridership feature landed, and any future feature just needs a value below.
def _feature_row(feats: dict, vals: dict) -> list[float]:
    enc = feats["encoders"]
    row: list[float] = []
    for c in feats["feat_order"]:
        if c in enc:  # categorical, label-encoded (-1 = unseen)
            row.append(enc[c].get(str(vals.get(c)), -1))
        else:  # numeric; missing -> 0.0 (must match train_eta's policy)
            v = vals.get(c)
            row.append(float(v) if v is not None else 0.0)
    return row


def _enrich(vals: dict, feats: dict) -> dict:
    """Server-side features Node doesn't send. Ridership/alert_active are
    computed here (and identically at train time) so the two can't drift;
    only when the loaded model actually uses them, so old models never
    trigger the profile fetch / alert lookup."""
    feat_order = feats.get("feat_order", [])
    if "ridership" in feat_order:
        vals["ridership"] = mta_ridership.busyness(
            vals.get("to_stop", ""), int(vals.get("hour", 12)), int(vals.get("dow", 1))
        )
    if "alert_active" in feat_order:
        vals["alert_active"] = 1.0 if active_alerts.is_active(vals.get("route_id")) else 0.0
    return vals


@app.get("/predict")
def predict(
    route_id: str,
    from_stop: str,
    to_stop: str,
    hour: int = 12,
    dow: int = 1,
    weather_score: float = 0.0,
    distance_m: float = 0.0,
    elevation: str = "underground",
):
    if _model is None or _feats is None:
        return JSONResponse({"error": "model not trained yet — run train_eta.py"}, status_code=503)
    vals = _enrich({
        "route_id": route_id, "from_stop": from_stop, "to_stop": to_stop,
        "elevation": elevation, "hour": hour, "dow": dow,
        "weather_score": weather_score, "distance_m": distance_m,
    }, _feats)
    X = np.array([_feature_row(_feats, vals)], dtype=np.float32)
    pred = float(_model.predict(X)[0])
    return {"predicted_travel_sec": round(pred, 1), "source": "model-v1"}


class HopRequest(BaseModel):
    id: str  # caller-defined key (e.g. "tripId|stopId|hopIndex") echoed back for mapping
    route_id: str
    from_stop: str
    to_stop: str
    hour: int = 12
    dow: int = 1
    weather_score: float = 0.0
    distance_m: float = 0.0
    elevation: str = "underground"


class RemainingRequest(BaseModel):
    id: str  # caller-defined key (tripId), echoed back for mapping
    route_id: str
    from_stop: str
    to_stop: str
    hour: int = 12
    dow: int = 1
    weather_score: float = 0.0
    distance_m: float = 0.0
    elevation: str = "underground"
    frac_hop: float = 0.0  # 0..1 progress into the current hop (Kalman-derived)
    kalman_speed: float = 0.0  # m/s, filtered
    trains_ahead: int = 0  # congestion within the look-ahead window


@app.post("/predict-remaining")
def predict_remaining(hops: list[RemainingRequest]):
    """model-v2: seconds REMAINING in the current hop, given how far through it
    the train already is (frac_hop) + speed + congestion. This is the late-bias
    fix — v1 always charged the FULL hop duration even for a train 90% of the
    way through. 503s until train_v2 has enough forward-only vehicle_log data."""
    if _model_v2 is None or _feats_v2 is None:
        return JSONResponse({"error": "model-v2 not trained yet — needs vehicle_log history"}, status_code=503)
    if not hops:
        return []
    X = np.array(
        [_feature_row(_feats_v2, _enrich(h.model_dump(), _feats_v2)) for h in hops],
        dtype=np.float32,
    )
    preds = _model_v2.predict(X)
    return [{"id": h.id, "remaining_sec": round(max(0.0, float(p)), 1)} for h, p in zip(hops, preds)]


@app.post("/predict-batch")
def predict_batch(hops: list[HopRequest]):
    """Batch segment-duration predictions, one model.predict() call for the
    whole tick's worth of hops — mirrors kalman-rs's POST /filter batch shape.
    Used by the server to chain per-hop durations into arrival-time predictions
    (source='model-v1') for the head-to-head backtest vs the feed."""
    if _model is None or _feats is None:
        return JSONResponse({"error": "model not trained yet — run train_eta.py"}, status_code=503)
    if not hops:
        return []
    X = np.array(
        [_feature_row(_feats, _enrich(h.model_dump(), _feats)) for h in hops],
        dtype=np.float32,
    )
    preds = _model.predict(X)
    return [{"id": h.id, "predicted_travel_sec": round(float(p), 1)} for h, p in zip(hops, preds)]


if __name__ == "__main__":
    import uvicorn
    print("[analytics-py] FastAPI on :8091 (docs at /docs)")
    uvicorn.run(app, host="0.0.0.0", port=8091)
