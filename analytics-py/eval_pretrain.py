"""Measure-first gate for the historical pretraining blend (roadmap: prove
before ship, same ethos as graph_experiment.py — STRICTLY OFFLINE, never touches
the live model files unless a candidate actually wins).

Temporal holdout on the live ledger:
  * CURRENT  = trained on the early time-slice only (ledger, no history)
  * CANDIDATE = same slice + down-weighted synthetic history (build_pretrain)
Both are scored on the SAME late holdout slice. Prints per-lead-bucket MAE/bias
for v1 (travel_sec) and v2 (remaining_sec), plus the metric that actually
motivates pretraining: MAE on COLD-START hops (holdout hops the train slice
never saw).

Promotion rule (--promote): copy candidate -> live model files ONLY if it beats
current on the target buckets (v1 cold-start MAE and/or v2 short-lead MAE) with
no material near-term regression. Default run just reports.

Run: python analytics-py/eval_pretrain.py            (report only)
     python analytics-py/eval_pretrain.py --promote   (promote if it wins)
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime

import numpy as np
import xgboost as xgb

import build_pretrain
import featurize
import mta_ridership
import train_eta as T

HERE = os.path.dirname(__file__)
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))
HOLDOUT_FRAC = 0.2          # last 20% of time = holdout
V2_BUCKETS = [("0-1 min", 0, 60), ("1-2 min", 60, 120), ("2-5 min", 120, 300),
              ("5-10 min", 300, 600), ("10+ min", 600, 10**9)]
WIN_MARGIN_S = 1.0
NEAR_REGRESS_TOL_S = 2.0    # allow at most this much near-term MAE regression


def _xgb():
    return xgb.XGBRegressor(n_estimators=150, max_depth=4, learning_rate=0.1,
                            subsample=0.9, objective="reg:squarederror")


def _fit(rows, syn, cat, num, feat_order, label, syn_weight):
    """Train one model on rows (+optional syn, down-weighted). Encoders over the
    union so the two models share a vocabulary with the holdout. Encoding goes
    through the shared featurize module — the same path training and serving use."""
    allr = rows + (syn or [])
    enc = featurize.build_encoders(allr, cat)
    X = featurize.encode_rows(allr, feat_order, enc)
    y = featurize.labels(allr, label)
    w = np.array([1.0] * len(rows) + [syn_weight] * len(syn or []), dtype=np.float32)
    m = _xgb()
    m.fit(X, y, sample_weight=w)
    return m, enc


def _mae_bias(model, enc, rows, cat, num, feat_order, label):
    X = featurize.encode_rows(rows, feat_order, enc)
    y = featurize.labels(rows, label)
    p = model.predict(X)
    return p - y  # error array (pred - actual)


# ------------------------------------------------------------------ v1

def _load_v1():
    con = sqlite3.connect(LEDGER)
    cur = con.execute(
        "SELECT route_id, from_stop, to_stop, elevation, hour, dow, weather_score, "
        "distance_m, arrive_ts, travel_sec FROM segments WHERE travel_sec IS NOT NULL "
        "ORDER BY arrive_ts")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    alert_index = T._load_alert_index(con)
    con.close()
    mta_ridership.ensure_profile()
    for r in rows:
        b = mta_ridership.busyness(r["to_stop"], r["hour"] or 0, r["dow"] or 0)
        r["ridership"] = b if b is not None else 0.0
        r["alert_active"] = T._alert_active(alert_index, r["route_id"], r["arrive_ts"])
    return rows


def eval_v1():
    rows = _load_v1()
    if len(rows) < 500:
        print(f"[eval-v1] only {len(rows)} segments — too few for a holdout; skipping.")
        return None
    cut = int(len(rows) * (1 - HOLDOUT_FRAC))
    train_rows, hold = rows[:cut], rows[cut:]
    train_hops = {(r["from_stop"], r["to_stop"]) for r in train_rows}
    cold = [r for r in hold if (r["from_stop"], r["to_stop"]) not in train_hops]
    syn, _, st = build_pretrain.load()

    cur_m, cur_e = _fit(train_rows, None, T.CAT, T.NUM, T.FEAT_ORDER, "travel_sec", 0.0)
    cand_m, cand_e = _fit(train_rows, syn, T.CAT, T.NUM, T.FEAT_ORDER, "travel_sec", T.PRETRAIN_WEIGHT)

    def mae(model, enc, rs):
        if not rs:
            return None
        return float(np.abs(_mae_bias(model, enc, rs, T.CAT, T.NUM, T.FEAT_ORDER, "travel_sec")).mean())

    res = {
        "n_train": len(train_rows), "n_holdout": len(hold), "n_cold": len(cold),
        "overall": {"current": mae(cur_m, cur_e, hold), "candidate": mae(cand_m, cand_e, hold)},
        "cold_start": {"current": mae(cur_m, cur_e, cold), "candidate": mae(cand_m, cand_e, cold)},
    }
    print("\n=== v1 (travel_sec) temporal holdout ===")
    print(f"  train={res['n_train']}  holdout={res['n_holdout']}  cold-start hops={res['n_cold']}")
    _row("overall MAE", res["overall"])
    _row("cold-start MAE", res["cold_start"])
    return res


# ------------------------------------------------------------------ v2

def eval_v2():
    rows = T.load_v2_instances()
    if len(rows) < 500:
        print(f"[eval-v2] only {len(rows)} mid-hop samples — too few for a holdout; skipping.")
        return None
    rows.sort(key=lambda r: r["ts"])
    cut = int(len(rows) * (1 - HOLDOUT_FRAC))
    train_rows, hold = rows[:cut], rows[cut:]
    _, syn, st = build_pretrain.load()

    cur_m, cur_e = _fit(train_rows, None, T.CAT_V2, T.NUM_V2, T.FEAT_ORDER_V2, "remaining_sec", 0.0)
    cand_m, cand_e = _fit(train_rows, syn, T.CAT_V2, T.NUM_V2, T.FEAT_ORDER_V2, "remaining_sec", T.PRETRAIN_WEIGHT)

    e_cur = _mae_bias(cur_m, cur_e, hold, T.CAT_V2, T.NUM_V2, T.FEAT_ORDER_V2, "remaining_sec")
    e_cand = _mae_bias(cand_m, cand_e, hold, T.CAT_V2, T.NUM_V2, T.FEAT_ORDER_V2, "remaining_sec")
    lead = np.array([float(r["remaining_sec"]) for r in hold])

    print("\n=== v2 (remaining_sec) temporal holdout — MAE / bias by lead bucket ===")
    print(f"  train={len(train_rows)}  holdout={len(hold)}")
    hdr = f"  {'bucket':9s} {'n':>6s} {'cur MAE':>8s} {'cand MAE':>9s} {'cur bias':>9s} {'cand bias':>10s}"
    print(hdr); print("  " + "-" * (len(hdr) - 2))
    buckets = {}
    for name, lo, hi in V2_BUCKETS:
        mask = (lead >= lo) & (lead < hi)
        nb = int(mask.sum())
        if nb == 0:
            continue
        cm, dm = float(np.abs(e_cur[mask]).mean()), float(np.abs(e_cand[mask]).mean())
        cb, db = float(e_cur[mask].mean()), float(e_cand[mask].mean())
        buckets[name] = {"n": nb, "cur_mae": cm, "cand_mae": dm, "cur_bias": cb, "cand_bias": db}
        print(f"  {name:9s} {nb:>6d} {cm:>8.1f} {dm:>9.1f} {cb:>9.1f} {db:>10.1f}")
    return {"n_train": len(train_rows), "n_holdout": len(hold), "buckets": buckets}


# ------------------------------------------------------------------ report/promote

def _row(label, d):
    c, k = d.get("current"), d.get("candidate")
    if c is None or k is None:
        print(f"  {label:16s}: n/a")
        return
    delta = c - k
    tag = "IMPROVED" if delta > WIN_MARGIN_S else ("regressed" if delta < -WIN_MARGIN_S else "~flat")
    print(f"  {label:16s}: current={c:.1f}s  candidate={k:.1f}s  ({tag} {delta:+.1f}s)")


def _verdict(v1, v2):
    """Promote if a target bucket improves and no near-term bucket regresses
    beyond tolerance. Wins and blocks are tracked SEPARATELY — a block is a
    veto, never outvoted by a later win (the test suite pins this: a near-term
    regression plus a long-lead win must NOT promote)."""
    reasons = []
    win = False
    blocked = False
    if v1 and v1["cold_start"]["current"] and v1["cold_start"]["candidate"]:
        d = v1["cold_start"]["current"] - v1["cold_start"]["candidate"]
        if d > WIN_MARGIN_S:
            win = True; reasons.append(f"v1 cold-start MAE -{d:.1f}s")
        elif d < -WIN_MARGIN_S:
            reasons.append(f"v1 cold-start REGRESSED {d:.1f}s")
    if v1 and v1["overall"]["current"] and v1["overall"]["candidate"]:
        if v1["overall"]["candidate"] > v1["overall"]["current"] + NEAR_REGRESS_TOL_S:
            blocked = True; reasons.append("v1 overall regressed beyond tol — blocked")
    if v2:
        for name in ("0-1 min", "1-2 min"):
            b = v2["buckets"].get(name)
            if b and b["cand_mae"] > b["cur_mae"] + NEAR_REGRESS_TOL_S:
                blocked = True; reasons.append(f"v2 {name} regressed beyond tol — blocked")
        for name in ("2-5 min", "5-10 min", "10+ min"):
            b = v2["buckets"].get(name)
            if b and b["cur_mae"] - b["cand_mae"] > WIN_MARGIN_S:
                win = True; reasons.append(f"v2 {name} MAE -{b['cur_mae']-b['cand_mae']:.1f}s")
    return win and not blocked, reasons


def promote():
    """Retrain full models WITH history and overwrite the live files. Only call
    after a winning verdict."""
    os.environ["PRETRAIN_HISTORY"] = "1"
    import importlib
    importlib.reload(T)
    print("\n[promote] retraining full v1+v2 on ALL ledger + history …")
    T.train()
    try:
        T.train_v2()
    except Exception as e:
        print("[promote] v2 retrain skipped:", e)
    print("[promote] live model files updated (app.py hot-reloads on next cycle).")


if __name__ == "__main__":
    print(f"[eval] ledger={LEDGER}  holdout_frac={HOLDOUT_FRAC}  syn_weight={T.PRETRAIN_WEIGHT}")
    v1 = eval_v1()
    v2 = eval_v2()
    win, reasons = _verdict(v1, v2)
    print("\n=== VERDICT ===")
    for r in reasons:
        print("  -", r)
    print(f"  => {'PROMOTE' if win else 'DO NOT PROMOTE'} (candidate {'beats' if win else 'does not beat'} current)")
    if win and "--promote" in sys.argv:
        promote()
    elif win:
        print("  (re-run with --promote to write the winning blend to the live models)")
