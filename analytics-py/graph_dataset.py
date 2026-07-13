"""Phase 2 of the graph-ETA plan: build the per-snapshot graph dataset.

Every graph condition (A/B/C) is a RESIDUAL correction on top of model-v2:
each node is a v2 instance (a train mid-hop) carrying v2's own prediction, and
the target is the error v2 makes — `remaining_sec - v2_pred`. The graph lets a
node's residual depend on nearby trains (FOLLOWS = the train ahead on its line;
SHARES_TRACK = a cross-route train at a shared junction).

DESIGN NOTE (a deliberate, tractable refinement of the plan's "ego-subgraph vs
whole-network" split): rather than materialize 1.7M separate ego-subgraphs, we
build ONE graph per 30s snapshot (all active trains as nodes, BOTH edge types
present). The A/B/C conditions then differ purely in the MODEL, not the data:
  Graph A = 2-layer GNN over FOLLOWS edges only     (local same-line)
  Graph B = 2-layer GNN over FOLLOWS + SHARES        (local junctions)
  Graph C = 3-5 layer GNN over FOLLOWS + SHARES       (network-wide propagation)
A 2-layer GNN on a whole-snapshot graph only ever sees a node's 2-hop
neighborhood, so it IS the "local ego-subgraph" — this is the same ablation the
plan describes ("Graph A simply drops shares"), just built once instead of
millions of times. Every node has a label, so every node is scored.

Feature parity: instances come from train_eta.load_v2_instances() — the exact
same join/enrichment v2 trains on — and v2_pred is computed with the saved v2
model + encoders, so the residual baseline can't drift from live v2.

Run: python analytics-py/graph_dataset.py   (writes data/exports/graph/dataset.pt)
Env: MAX_SNAPSHOTS caps snapshots for a fast smoke run (default: all).
"""
import json
import math
import os

import numpy as np
import torch
import xgboost as xgb
from torch_geometric.data import HeteroData

import train_eta

HERE = os.path.dirname(__file__)
GRAPH_DIR = os.environ.get("GRAPH_EXPORT_DIR", os.path.join(HERE, "..", "data", "exports", "graph"))
MODEL_DIR = os.environ.get("MODEL_DIR", HERE)

SNAP_SECONDS = 30  # snapshot grid — matches the feed poll grain
LABEL_HORIZON_S = 1800  # max remaining_sec (from load_v2_instances' filter)
MIN_TRAINS_PER_SNAP = 2  # a graph needs >= 2 trains to have any edge at all
N_FOLDS = 3  # expanding-window temporal CV
MAX_SNAPSHOTS = int(os.environ.get("MAX_SNAPSHOTS", "0")) or None

# node feature columns (numeric); v2_pred prepended at build time. Deliberately
# excludes the high-cardinality stop ids — the graph STRUCTURE encodes spatial
# relationships; these numerics + v2_pred carry the per-node signal.
# Derived from THE feature registry (shared/features.json, P5): the v2-only
# numerics first, then the shared numerics — same set v2 trains on.
import featurize as _fz
_S = _fz.feature_spec()
NODE_NUM = list(_S["v2_extra_num"]) + list(_S["num"])


def _v2_predict(rows):
    """model-v2's own prediction per instance, via the saved model + encoders —
    identical to app.py's serving path (both go through featurize.encode_rows),
    so residual targets match live v2."""
    import featurize
    with open(os.path.join(MODEL_DIR, "eta_features_v2.json")) as f:
        feats = json.load(f)
    model = xgb.XGBRegressor()
    model.load_model(os.path.join(MODEL_DIR, "eta_model_v2.json"))
    X = featurize.encode_rows(rows, feats["feat_order"], feats["encoders"])
    return model.predict(X)


def _spine_pos(follows_order, route, direction, from_stop, to_stop, frac):
    order = follows_order.get(f"{route}|{direction}")
    if not order:
        return None
    to_idx = order.get(to_stop)
    if to_idx is None:
        return None
    from_idx = order.get(from_stop)
    return from_idx + frac if from_idx is not None else to_idx - (1 - frac)


def build():
    follows_order = json.load(open(os.path.join(GRAPH_DIR, "follows_order.json")))
    raw_zones = json.load(open(os.path.join(GRAPH_DIR, "shares_track.json")))
    share_zones = [
        {"a": z["route_a"], "b": z["route_b"], "dir": z["direction"], "stops": set(z["stop_ids"])}
        for z in raw_zones if z["source"] == "stopseq"
    ]

    rows = train_eta.load_v2_instances()
    if not rows:
        print("[graph_dataset] no v2 instances yet — the forward-only vehicle_log "
              "needs runtime. Nothing to build.")
        return
    print(f"[graph_dataset] {len(rows)} base instances (matches train_v2's join)")

    v2_pred = _v2_predict(rows)
    for r, p in zip(rows, v2_pred):
        r["v2_pred"] = float(p)
        r["residual"] = float(r["remaining_sec"]) - float(p)
        r["dir"] = r["to_stop"][-1] if r["to_stop"] and r["to_stop"][-1] in "NS" else ""
        r["snap"] = int(r["ts"]) // SNAP_SECONDS * SNAP_SECONDS

    # dedupe: one row per (snapshot, trip) — keep the latest ts in the bucket
    by_key = {}
    for r in rows:
        k = (r["snap"], r["trip_id"])
        if k not in by_key or r["ts"] > by_key[k]["ts"]:
            by_key[k] = r
    deduped = list(by_key.values())

    # standardization stats over all instances (stored for serving)
    num = np.array([[float(r.get(c) or 0.0) for c in NODE_NUM] for r in deduped], dtype=np.float32)
    vp = np.array([[r["v2_pred"]] for r in deduped], dtype=np.float32)
    feat_all = np.hstack([vp, num])
    mean = feat_all.mean(axis=0)
    std = feat_all.std(axis=0) + 1e-6

    # group into snapshots
    snaps = {}
    for r in deduped:
        snaps.setdefault(r["snap"], []).append(r)
    snap_ids = sorted(s for s, members in snaps.items() if len(members) >= MIN_TRAINS_PER_SNAP)
    if MAX_SNAPSHOTS and len(snap_ids) > MAX_SNAPSHOTS:
        # even stride across the FULL time range (not the first N) so a capped
        # smoke run is representative of the whole span, not one narrow window
        stride = len(snap_ids) / MAX_SNAPSHOTS
        snap_ids = [snap_ids[int(i * stride)] for i in range(MAX_SNAPSHOTS)]
    print(f"[graph_dataset] {len(snap_ids)} snapshots with >= {MIN_TRAINS_PER_SNAP} trains")

    graphs = []
    edge_bearing_nodes = 0
    total_nodes = 0
    for snap in snap_ids:
        members = snaps[snap]
        idx = {r["trip_id"]: i for i, r in enumerate(members)}
        n = len(members)

        x = np.hstack([
            np.array([[r["v2_pred"]] for r in members], dtype=np.float32),
            np.array([[float(r.get(c) or 0.0) for c in NODE_NUM] for r in members], dtype=np.float32),
        ])
        x = (x - mean) / std

        # FOLLOWS edges: per route|dir, sort by spine pos, link adjacent (both
        # directions so message passing flows leader<->follower)
        follows_src, follows_dst = [], []
        by_rd = {}
        for r in members:
            sp = _spine_pos(follows_order, r["route_id"], r["dir"], r["from_stop"], r["to_stop"], r["frac_hop"])
            if sp is not None:
                by_rd.setdefault((r["route_id"], r["dir"]), []).append((sp, idx[r["trip_id"]]))
        for group in by_rd.values():
            group.sort()
            for i in range(len(group) - 1):
                a, b = group[i][1], group[i + 1][1]
                follows_src += [a, b]
                follows_dst += [b, a]

        # SHARES edges: per zone, connect cross-route trains in the zone (both dirs)
        shares_src, shares_dst = [], []
        for z in share_zones:
            inA = [idx[r["trip_id"]] for r in members if r["route_id"] == z["a"] and r["dir"] == z["dir"] and r["to_stop"] in z["stops"]]
            inB = [idx[r["trip_id"]] for r in members if r["route_id"] == z["b"] and r["dir"] == z["dir"] and r["to_stop"] in z["stops"]]
            for a in inA:
                for b in inB:
                    shares_src += [a, b]
                    shares_dst += [b, a]

        data = HeteroData()
        data["train"].x = torch.tensor(x, dtype=torch.float)
        data["train"].y = torch.tensor([r["residual"] for r in members], dtype=torch.float)
        data["train"].v2_pred = torch.tensor([r["v2_pred"] for r in members], dtype=torch.float)
        data["train"].remaining = torch.tensor([float(r["remaining_sec"]) for r in members], dtype=torch.float)
        data["train"].ts = torch.tensor([int(r["ts"]) for r in members], dtype=torch.long)
        data["train", "follows", "train"].edge_index = torch.tensor(
            [follows_src, follows_dst], dtype=torch.long) if follows_src else torch.zeros((2, 0), dtype=torch.long)
        data["train", "shares", "train"].edge_index = torch.tensor(
            [shares_src, shares_dst], dtype=torch.long) if shares_src else torch.zeros((2, 0), dtype=torch.long)
        # trip_ids kept out-of-tensor for the leakage guard in the split
        data.trip_ids = [r["trip_id"] for r in members]
        data.snap = snap
        graphs.append(data)

        deg = np.zeros(n)
        for s in follows_src + shares_src:
            deg[s] += 1
        edge_bearing_nodes += int((deg > 0).sum())
        total_nodes += n

    print(f"[graph_dataset] {total_nodes} nodes total, "
          f"{edge_bearing_nodes} edge-bearing ({100*edge_bearing_nodes/max(1,total_nodes):.0f}%)")

    # ---- temporal expanding-window folds with leakage guards ----
    graphs.sort(key=lambda g: g.snap)
    ts_min, ts_max = graphs[0].snap, graphs[-1].snap
    span = ts_max - ts_min
    folds = []
    for k in range(1, N_FOLDS + 1):
        # fold k: train on [start, cut_k], test on (cut_k + gap, cut_{k+1}]
        cut = ts_min + span * (k / (N_FOLDS + 1))
        test_end = ts_min + span * ((k + 1) / (N_FOLDS + 1))
        train_g = [g for g in graphs if g.snap <= cut]
        # gap of one full label horizon so no training label realizes inside the test window
        test_g = [g for g in graphs if cut + LABEL_HORIZON_S < g.snap <= test_end]
        # trip purity: drop test nodes whose trip appeared in training
        train_trips = set()
        for g in train_g:
            train_trips.update(g.trip_ids)
        test_g = [_mask_test_trips(g, train_trips) for g in test_g]
        test_g = [g for g in test_g if g is not None]
        if train_g and test_g:
            folds.append({"train": train_g, "test": test_g})
            print(f"[graph_dataset]   fold {k}: {len(train_g)} train / {len(test_g)} test snapshots")

    meta = {
        "node_feat": ["v2_pred"] + NODE_NUM,
        "mean": mean.tolist(), "std": std.tolist(),
        "snap_seconds": SNAP_SECONDS, "label_horizon_s": LABEL_HORIZON_S,
        "n_snapshots": len(graphs), "n_nodes": total_nodes,
        "edge_bearing_frac": edge_bearing_nodes / max(1, total_nodes),
    }
    os.makedirs(GRAPH_DIR, exist_ok=True)
    out = os.path.join(GRAPH_DIR, "dataset.pt")
    torch.save({"folds": folds, "meta": meta}, out)
    with open(os.path.join(GRAPH_DIR, "dataset_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[graph_dataset] wrote {out} ({len(folds)} folds)")
    return folds, meta


def _mask_test_trips(g, train_trips):
    """Return a copy of snapshot g keeping only nodes whose trip wasn't in
    training (leakage guard). None if nothing survives. Rebuilds edges over the
    surviving node subset so indices stay valid."""
    keep = [i for i, tid in enumerate(g.trip_ids) if tid not in train_trips]
    if len(keep) < MIN_TRAINS_PER_SNAP:
        return None
    remap = {old: new for new, old in enumerate(keep)}
    keep_t = torch.tensor(keep, dtype=torch.long)
    out = HeteroData()
    out["train"].x = g["train"].x[keep_t]
    out["train"].y = g["train"].y[keep_t]
    out["train"].v2_pred = g["train"].v2_pred[keep_t]
    out["train"].remaining = g["train"].remaining[keep_t]
    out["train"].ts = g["train"].ts[keep_t]
    for rel in [("train", "follows", "train"), ("train", "shares", "train")]:
        ei = g[rel].edge_index
        cols = [(remap[int(s)], remap[int(d)]) for s, d in ei.t().tolist()
                if int(s) in remap and int(d) in remap]
        out[rel].edge_index = (torch.tensor(cols, dtype=torch.long).t().contiguous()
                               if cols else torch.zeros((2, 0), dtype=torch.long))
    out.trip_ids = [g.trip_ids[i] for i in keep]
    out.snap = g.snap
    return out


if __name__ == "__main__":
    build()
