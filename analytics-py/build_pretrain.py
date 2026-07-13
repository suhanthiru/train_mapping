"""Build synthetic pretraining rows from MTA historical Open Data, matching the
live `segments` / v2-instance schemas so train_eta.py can blend them with the
ledger (down-weighted) to cover the regions the forward-only ledger is starved
in — chiefly COLD-START hops (measured: ~1/3 of distinct hops seen exactly once).

Source join: sp9g-mzjh End-to-End Running Times  ×  tdmq-asac Subway Paths
(on stop_path_id). A path's end-to-end `average_actual_runtime` (minutes) is
split into consecutive-hop `travel_sec`, allocated PROPORTIONAL to the tracker's
own segments.distance_m where that hop is known, else UNIFORM (runtime/n_hops).

Honest limits (surfaced, not hidden):
  * tdmq-asac has no per-hop distance, so allocation is an estimate.
  * time_period collapses to one representative hour; day_type to one
    representative dow. Synthetic rows are a PRIOR, not ground truth — hence the
    down-weight in train_eta and the measure-first promotion gate.
  * v2 (remaining_sec) synthesis assumes normal-service physics (trains_ahead=0).
    A single subway hop is ~2 min, so this mainly reinforces near/mid-term; the
    truly starved 5-10/10+ min v2 buckets are disruption-driven and are the
    anomaly detector's job, not aggregate pretraining's. Documented as such.

Output: two lists of feature dicts (v1 rows keyed like segments, v2 mid-hop
rows), cached gzipped under data/history_cache. Run standalone to (re)build +
print coverage / ID-alignment stats.
"""
import gzip
import json
import os
import random
import sqlite3

import mta_history
import mta_ridership

HERE = os.path.dirname(__file__)
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))
CACHE_DIR = os.environ.get("HISTORY_CACHE_DIR", os.path.join(HERE, "..", "data", "history_cache"))

# representative expansions (documented lossy mapping). HOUR_OF keyed by the
# NORMALIZED (lowercase) period token — the source data mixes casing
# ("AM peak" but "midday"/"evening"/"overnight"), so we normalize before lookup.
DOW_OF = {"Weekday": 3, "Saturday": 6, "Sunday": 0}       # 0=Sun..6=Sat
HOUR_OF = {"am peak": 8, "midday": 13, "pm peak": 18, "evening": 21, "overnight": 3}
MI_TO_M = 1609.34

# v2 synthesis knobs — a few positions per hop, at avg AND p75 (slower) hop time
V2_FRACS = (0.15, 0.4, 0.7)
V2_MAX_ROWS = int(os.environ.get("PRETRAIN_V2_MAX", "400000"))
PRETRAIN_MAX_PATHS = int(os.environ.get("PRETRAIN_MAX_PATHS", "0")) or None  # 0=all


def _ledger_hop_distance():
    """(from_stop,to_stop) -> median distance_m from the tracker's own segments,
    so historical hops reuse real geometry where the ledger has seen them."""
    dist = {}
    if not os.path.exists(LEDGER):
        return dist
    con = sqlite3.connect(LEDGER)
    for f, t, d in con.execute(
        "SELECT from_stop, to_stop, distance_m FROM segments WHERE distance_m IS NOT NULL"
    ):
        dist.setdefault((f, t), []).append(d)
    con.close()
    return {k: sorted(v)[len(v) // 2] for k, v in dist.items()}


def _ledger_stop_vocab():
    """Set of from_stop/to_stop the live model's encoders already know — the
    ID-alignment gate compares synthetic ids against this."""
    vocab = set()
    if not os.path.exists(LEDGER):
        return vocab
    con = sqlite3.connect(LEDGER)
    for (s,) in con.execute("SELECT DISTINCT from_stop FROM segments"):
        vocab.add(s)
    for (s,) in con.execute("SELECT DISTINCT to_stop FROM segments"):
        vocab.add(s)
    con.close()
    return vocab


def _aggregate_runtimes():
    """Collapse months: (stop_path_id, day_type, time_period) -> n_trains-weighted
    mean avg_min + p75_min, keeping n_stops. Deduplicates the per-month rows into
    one expected runtime per path-condition."""
    acc = {}
    for r in mta_history.runtimes():
        key = (r["stop_path_id"], r["day_type"], r["time_period"])
        w = max(1, r["n_trains"])
        a = acc.setdefault(key, {"w": 0, "avg": 0.0, "p75": 0.0,
                                 "n_stops": r["n_stops"], "distance_mi": r["distance_mi"]})
        a["w"] += w
        a["avg"] += r["avg_min"] * w
        a["p75"] += r["p75_min"] * w
    for a in acc.values():
        a["avg"] /= a["w"]
        a["p75"] /= a["w"]
    return acc


def build():
    """Return (v1_rows, v2_rows, stats). v1 rows dedup to one prior per
    (from,to,hour,dow) with mean travel_sec; v2 derived from those hops."""
    paths = mta_history.paths_index()
    agg = _aggregate_runtimes()
    hop_dist = _ledger_hop_distance()
    vocab = _ledger_stop_vocab()
    elev_map = mta_history.structure_elevation()
    mta_ridership.ensure_profile()

    keys = list(agg.keys())
    if PRETRAIN_MAX_PATHS:
        keys = keys[:PRETRAIN_MAX_PATHS]

    # accumulate per hop-condition: (from,to,hour,dow) -> {travel_sec[], line, elev, dist_m}
    v1acc = {}
    considered = matched_geo = 0
    for (pid, day_type, period) in keys:
        pinfo = paths.get(pid)
        if not pinfo or len(pinfo.get("stops", [])) < 2:
            continue
        a = agg[(pid, day_type, period)]
        stops = pinfo["stops"]
        direction = pinfo["direction"]
        line = pinfo["line"]
        n_hops = len(stops) - 1
        hour = HOUR_OF.get(mta_history.norm_period(period), 12)
        dow = DOW_OF.get(day_type, 3)
        total_sec = a["avg"] * 60.0
        total_p75 = a["p75"] * 60.0

        # per-hop distance weights (real where known, else uniform share of path)
        suff = [mta_history._suffix(s, direction) for s in stops]
        hop_m = []
        for i in range(n_hops):
            considered += 1
            dm = hop_dist.get((suff[i], suff[i + 1]))
            if dm is not None:
                matched_geo += 1
            hop_m.append(dm)
        known = [m for m in hop_m if m is not None]
        path_m = a["distance_mi"] * MI_TO_M
        fallback_m = (path_m / n_hops) if n_hops else path_m
        hop_m = [m if m is not None else fallback_m for m in hop_m]
        wsum = sum(hop_m) or (n_hops or 1)

        for i in range(n_hops):
            fs, tsid = suff[i], suff[i + 1]
            share = hop_m[i] / wsum
            travel = max(2.0, total_sec * share)
            travel75 = max(travel, total_p75 * share)
            elev = elev_map.get(stops[i + 1]) or elev_map.get(stops[i]) or "underground"
            k = (fs, tsid, hour, dow)
            e = v1acc.setdefault(k, {"line": line, "elev": elev, "dist_m": hop_m[i],
                                     "travel": [], "travel75": []})
            e["travel"].append(travel)
            e["travel75"].append(travel75)

    # emit deduped v1 rows (mean travel_sec per hop-condition)
    v1_rows = []
    for (fs, tsid, hour, dow), e in v1acc.items():
        travel = sum(e["travel"]) / len(e["travel"])
        rid = mta_ridership.busyness(tsid, hour, dow)
        v1_rows.append({
            "route_id": e["line"], "from_stop": fs, "to_stop": tsid,
            "elevation": e["elev"], "hour": hour, "dow": dow,
            "weather_score": None, "distance_m": e["dist_m"],
            "ridership": rid if rid is not None else 0.0, "alert_active": 0.0,
            "travel_sec": travel,
        })

    # emit v2 mid-hop rows from the same hop-conditions (avg + p75 hop time)
    v2_rows = []
    for (fs, tsid, hour, dow), e in v1acc.items():
        t_avg = sum(e["travel"]) / len(e["travel"])
        t_p75 = sum(e["travel75"]) / len(e["travel75"])
        dist_m = e["dist_m"] or 0.0
        rid = mta_ridership.busyness(tsid, hour, dow)
        for hoptime in (t_avg, t_p75):
            speed = (dist_m / hoptime) if hoptime > 0 else 0.0
            for frac in V2_FRACS:
                v2_rows.append({
                    "route_id": e["line"], "from_stop": fs, "to_stop": tsid,
                    "elevation": e["elev"], "hour": hour, "dow": dow,
                    "weather_score": None, "distance_m": dist_m,
                    "ridership": rid if rid is not None else 0.0, "alert_active": 0.0,
                    "frac_hop": frac, "kalman_speed": speed, "trains_ahead": 0,
                    "remaining_sec": max(2.0, hoptime * (1.0 - frac)),
                })
    if len(v2_rows) > V2_MAX_ROWS:
        random.seed(0)
        v2_rows = random.sample(v2_rows, V2_MAX_ROWS)

    # ID-alignment gate: fraction of synthetic stop ids the live vocab knows
    syn_ids = {r["from_stop"] for r in v1_rows} | {r["to_stop"] for r in v1_rows}
    hit = sum(1 for s in syn_ids if s in vocab)
    stats = {
        "v1_rows": len(v1_rows), "v2_rows": len(v2_rows),
        "distinct_hop_conditions": len(v1acc),
        "geo_match_frac": round(matched_geo / max(1, considered), 3),
        "id_align_frac": round(hit / max(1, len(syn_ids)), 3),
        "id_align_hits": hit, "id_align_total": len(syn_ids),
        "ledger_vocab": len(vocab),
        "elev_underground": sum(1 for r in v1_rows if r["elevation"] == "underground"),
        "sched_hops": len(mta_history.schedule_hop_seconds()),
    }
    return v1_rows, v2_rows, stats


def _cache_path(name):
    return os.path.join(CACHE_DIR, f"{name}.json.gz")


def load(rebuild=False):
    """Cached (v1_rows, v2_rows, stats)."""
    p1, p2, ps = _cache_path("pretrain_v1"), _cache_path("pretrain_v2"), _cache_path("pretrain_stats")
    if not rebuild and all(os.path.exists(p) for p in (p1, p2, ps)):
        with gzip.open(p1, "rt", encoding="utf-8") as f:
            v1 = json.load(f)
        with gzip.open(p2, "rt", encoding="utf-8") as f:
            v2 = json.load(f)
        with gzip.open(ps, "rt", encoding="utf-8") as f:
            st = json.load(f)
        return v1, v2, st
    v1, v2, st = build()
    os.makedirs(CACHE_DIR, exist_ok=True)
    for path, data in ((p1, v1), (p2, v2), (ps, st)):
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(data, f)
    return v1, v2, st


if __name__ == "__main__":
    v1, v2, st = load(rebuild=True)
    print("[build_pretrain] coverage / ID-alignment:")
    for k, v in st.items():
        print(f"    {k}: {v}")
    print("    sample v1:", v1[0] if v1 else None)
    print("    sample v2:", v2[0] if v2 else None)
    if st["id_align_frac"] < 0.5:
        print("    ** WARNING: low ID alignment — synthetic ids miss the live vocab; "
              "check suffix reconstruction before training.")
