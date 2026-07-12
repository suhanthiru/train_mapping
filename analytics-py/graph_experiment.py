"""Phase 4 of the graph-ETA plan: the four-condition offline experiment.

Trains Graph A/B/C on the shared temporal folds (Baseline needs no training —
its residual is identically 0, i.e. plain model-v2), evaluates all four on the
SAME held-out test nodes, and prints MAE/bias by lead-time bucket plus PAIRED
head-to-head win-rates (same nodes only, so composition can't fake a result).

Final prediction per node = v2_pred + condition_residual; error = final - actual
remaining. Baseline's error is therefore v2's own error — the thing the graph is
trying to correct.

STRICTLY OFFLINE: reads only data/exports/graph/dataset.pt, writes only
data/exports/graph/experiment_report.json. Never touches data/ledger.db or the
live dashboard — a broken/unproven graph model can't pollute production.

Run: python analytics-py/graph_experiment.py
"""
import json
import os

import numpy as np
import torch

import graph_model

HERE = os.path.dirname(__file__)
GRAPH_DIR = os.environ.get("GRAPH_EXPORT_DIR", os.path.join(HERE, "..", "data", "exports", "graph"))

BUCKETS = [("0-1 min", 0, 60), ("1-2 min", 60, 120), ("2-5 min", 120, 300),
           ("5-10 min", 300, 600), ("10+ min", 600, 10**9)]
SHORT_LEAD = ("0-1 min", "1-2 min")  # the buckets the ship gate is judged on
WIN_MARGIN_S = 2.0  # a condition must beat another by > this (MAE) to "PASS"
MIN_N_GATE = 1000  # edge-bearing test nodes per short-lead bucket for a real verdict
FEED_REF = {"0-1 min": 19, "1-2 min": 23}  # measured feed MAE, printed for context
V2_REF = {"0-1 min": 86, "1-2 min": 69}    # measured v2 MAE, printed for context


def _bucket(lead):
    for name, lo, hi in BUCKETS:
        if lo <= lead < hi:
            return name
    return "10+ min"


def _collect_preds(models, test_graphs):
    """Per-node records across all conditions on the identical test nodes:
    {lead, err_baseline, err_graph_a, err_graph_b, err_graph_c}."""
    recs = []
    with torch.no_grad():
        for g in test_graphs:
            v2 = g["train"].v2_pred.numpy()
            remaining = g["train"].remaining.numpy()
            resid = {c: models[c](g).numpy() if models[c] is not None else np.zeros_like(v2) for c in models}
            for i in range(len(remaining)):
                rec = {"lead": float(remaining[i]), "err_baseline": float(v2[i] - remaining[i])}
                for c in models:
                    final = v2[i] + resid[c][i]
                    rec[f"err_{c}"] = float(final - remaining[i])
                recs.append(rec)
    return recs


def _bucket_table(recs, key):
    """MAE/bias/median-abs-err by lead bucket for one condition's error key."""
    out = {}
    for name, lo, hi in BUCKETS:
        errs = [r[key] for r in recs if lo <= r["lead"] < hi]
        if errs:
            a = np.array(errs)
            out[name] = {"n": len(errs), "mae": round(float(np.abs(a).mean()), 1),
                         "bias": round(float(a.mean()), 1), "median_ae": round(float(np.median(np.abs(a))), 1)}
        else:
            out[name] = {"n": 0, "mae": 0.0, "bias": 0.0, "median_ae": 0.0}
    return out


def _short_lead_mae(recs, key):
    errs = [abs(r[key]) for r in recs if _bucket(r["lead"]) in SHORT_LEAD]
    return (float(np.mean(errs)) if errs else float("inf")), len(errs)


def _paired_winrate(recs, key_a, key_b):
    """Of nodes where both predicted, how often is key_a strictly closer."""
    wins = sum(1 for r in recs if abs(r[key_a]) < abs(r[key_b]))
    return round(100 * wins / max(1, len(recs)), 1)


def run():
    ds = torch.load(os.path.join(GRAPH_DIR, "dataset.pt"), weights_only=False)
    folds, meta = ds["folds"], ds["meta"]
    in_dim = len(meta["node_feat"])
    conditions = ["baseline", "graph_a", "graph_b", "graph_c"]
    graph_conds = ["graph_a", "graph_b", "graph_c"]

    all_recs = []
    for fi, fold in enumerate(folds, 1):
        print(f"[experiment] fold {fi}: training {len(fold['train'])} snapshots -> "
              f"testing {len(fold['test'])}")
        models = {"baseline": None}
        for cond in graph_conds:
            print(f"    training {cond} ...")
            m = graph_model.make_model(in_dim, cond)
            # small temporal val slice off the tail of train for early stopping
            split = max(1, int(len(fold["train"]) * 0.85))
            m = graph_model.train_one(m, fold["train"][:split], fold["train"][split:] or fold["train"][-3:])
            models[cond] = m
        all_recs.extend(_collect_preds(models, fold["test"]))

    print(f"\n[experiment] pooled test nodes: {len(all_recs)}\n")

    # ---- per-condition MAE/bias by lead bucket ----
    tables = {c: _bucket_table(all_recs, f"err_{c}") for c in conditions}
    hdr = f"{'condition':10s} {'bucket':9s} {'n':>7s} {'mae':>6s} {'bias':>6s} {'medAE':>6s}"
    print(hdr)
    print("-" * len(hdr))
    for c in conditions:
        for name, _, _ in BUCKETS:
            b = tables[c][name]
            ref = ""
            if c == "baseline" and name in FEED_REF:
                ref = f"   (feed~{FEED_REF[name]}s, v2~{V2_REF[name]}s)"
            print(f"{c:10s} {name:9s} {b['n']:>7d} {b['mae']:>6.1f} {b['bias']:>6.1f} {b['median_ae']:>6.1f}{ref}")

    # ---- paired head-to-head + verdict ----
    print("\n=== paired head-to-head (same test nodes) + verdict ===")
    base_mae, base_n = _short_lead_mae(all_recs, "err_baseline")
    verdicts = {}
    per_cond = {}
    for c in graph_conds:
        mae, n = _short_lead_mae(all_recs, f"err_{c}")
        per_cond[c] = {"short_lead_mae": round(mae, 1), "short_lead_n": n}
    a_mae = per_cond["graph_a"]["short_lead_mae"]
    b_mae = per_cond["graph_b"]["short_lead_mae"]
    c_mae = per_cond["graph_c"]["short_lead_mae"]

    def cmp(x, y):  # PASS if x beats y by > margin
        return "PASS" if x < y - WIN_MARGIN_S else "no"

    under = base_n < MIN_N_GATE
    tag = "  [UNDERPOWERED: below sample gate — directional only]" if under else ""
    print(f"baseline short-lead(0-2min) MAE = {base_mae:.1f}s (n={base_n}){tag}")
    print(f"graph_a  MAE={a_mae:.1f}s  vs baseline: {cmp(a_mae, base_mae)}  "
          f"(win-rate vs baseline {_paired_winrate(all_recs,'err_graph_a','err_baseline')}%)")
    print(f"graph_b  MAE={b_mae:.1f}s  vs baseline: {cmp(b_mae, base_mae)}  vs A: {cmp(b_mae, a_mae)}  "
          f"(win vs A {_paired_winrate(all_recs,'err_graph_b','err_graph_a')}%)")
    creg = "  <-- REGRESSION vs B: oversmoothing/oversquashing suspected" if c_mae > b_mae + WIN_MARGIN_S else ""
    print(f"graph_c  MAE={c_mae:.1f}s  vs baseline: {cmp(c_mae, base_mae)}  vs B: {cmp(c_mae, b_mae)}  "
          f"(win vs B {_paired_winrate(all_recs,'err_graph_c','err_graph_b')}%){creg}")

    verdicts = {
        "graph_a_vs_baseline": cmp(a_mae, base_mae),
        "graph_b_vs_baseline": cmp(b_mae, base_mae), "graph_b_vs_a": cmp(b_mae, a_mae),
        "graph_c_vs_baseline": cmp(c_mae, base_mae), "graph_c_vs_b": cmp(c_mae, b_mae),
        "graph_c_regresses_vs_b": bool(c_mae > b_mae + WIN_MARGIN_S),
        "underpowered": bool(under),
    }

    report = {
        "n_test_nodes": len(all_recs),
        "short_lead_mae": {"baseline": round(base_mae, 1), **{c: per_cond[c]["short_lead_mae"] for c in graph_conds}},
        "buckets": tables, "verdicts": verdicts, "meta": meta,
        "gate": {"min_n": MIN_N_GATE, "win_margin_s": WIN_MARGIN_S},
    }
    out = os.path.join(GRAPH_DIR, "experiment_report.json")
    with open(out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n[experiment] wrote {out}")
    return report


if __name__ == "__main__":
    run()
