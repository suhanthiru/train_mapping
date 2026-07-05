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
from typing import Optional

import numpy as np
import xgboost as xgb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import weather
import nyc311

HERE = os.path.dirname(__file__)
MODEL_PATH = os.path.join(HERE, "eta_model.json")
FEATS_PATH = os.path.join(HERE, "eta_features.json")

app = FastAPI(title="transit-analytics", version="0.2.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_model: Optional[xgb.XGBRegressor] = None
_feats: Optional[dict] = None


def load_model():
    global _model, _feats
    if os.path.exists(MODEL_PATH) and os.path.exists(FEATS_PATH):
        m = xgb.XGBRegressor()
        m.load_model(MODEL_PATH)
        _model = m
        with open(FEATS_PATH) as f:
            _feats = json.load(f)


load_model()


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _model is not None}


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
    return {
        "importance": _feats.get("importance", {}),
        "n_train": _feats.get("n_train"),
        "mae": _feats.get("mae"),
        "feat_order": _feats.get("feat_order"),
    }


@app.get("/predict")
def predict(
    route_id: str,
    from_stop: str,
    to_stop: str,
    hour: int = 12,
    dow: int = 1,
    weather_score: float = 0.0,
    occ_pct: float = 0.0,
):
    if _model is None or _feats is None:
        return JSONResponse({"error": "model not trained yet — run train_eta.py"}, status_code=503)
    enc = _feats["encoders"]
    row = [
        enc["route_id"].get(str(route_id), -1),
        enc["from_stop"].get(str(from_stop), -1),
        enc["to_stop"].get(str(to_stop), -1),
        float(hour), float(dow), float(weather_score), float(occ_pct),
    ]
    X = np.array([row], dtype=np.float32)
    pred = float(_model.predict(X)[0])
    return {"predicted_travel_sec": round(pred, 1), "source": "model-v1"}


if __name__ == "__main__":
    import uvicorn
    print("[analytics-py] FastAPI on :8091 (docs at /docs)")
    uvicorn.run(app, host="0.0.0.0", port=8091)
