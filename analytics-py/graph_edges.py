"""Phase 1 of the graph-ETA plan: static topology construction.

Builds two things purely from already-preprocessed GTFS static data (no raw
GTFS re-parse, no live/ledger data) — both are one-time, route-level, and
shared by every graph condition (A/B/C):

  FOLLOWS       canonical stop ordering per (route, direction) — "who's ahead
                of whom" resolves against this at snapshot time (see
                graph_dataset.py), not here.
  SHARES_TRACK  physical shared-track zones between DIFFERENT routes, same
                direction — where a train on one route can plausibly delay/be
                delayed by a train on another.

LOAD-BEARING FINDING (verified live, do not "simplify" this away): a
route+direction's shapesByRouteDir.json entry lists several shape variants,
and the FIRST-listed one is frequently a short work/turn variant, not the
main line (e.g. "3|S" first shape = 10 stops; the real trunk is 34). Using
the first-listed variant silently drops real SHARES_TRACK edges — verified
concretely: 4/5 sharing at Lexington comes out to 0 with the naive approach,
7 with the longest-variant fix. Always pick the shape with the MOST stops.

Run: python analytics-py/graph_edges.py
"""
import json
import math
import os

import polars as pl

HERE = os.path.dirname(__file__)
DATA_NYC = os.path.join(HERE, "..", "data", "nyc")
OUTDIR = os.environ.get("GRAPH_EXPORT_DIR", os.path.join(HERE, "..", "data", "exports", "graph"))

SHARES_TRACK_MIN_RUN = 4  # stop-id-run threshold (K)
GEO_EPSILON_M = 30  # geometric-fallback proximity threshold
GEO_MIN_RUN_M = 300  # minimum contiguous geometric overlap to count as a zone
DIRECTIONS = ("N", "S")


def _load_json(name):
    with open(os.path.join(DATA_NYC, name)) as f:
        return json.load(f)


def _haversine_m(a, b):
    """a, b = [lon, lat]. Same formula as shared/geo.ts's haversine, kept
    self-contained here since this is a standalone offline script."""
    R = 6371000.0
    lon1, lat1, lon2, lat2 = math.radians(a[0]), math.radians(a[1]), math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def canonical_shape_id(shapes_by_route_dir, shape_stops, route, direction):
    """The shape variant with the most stops for this route+direction, or
    None if this route doesn't run that direction at all."""
    variants = shapes_by_route_dir.get(f"{route}|{direction}", [])
    if not variants:
        return None
    return max(variants, key=lambda sid: len(shape_stops.get(sid, [])))


def canonical_spine(shape_stops, shape_id):
    """Ordered stop_id list for a shape, first-occurrence-deduped (defensive
    against loop shapes revisiting a stop_id)."""
    seen = set()
    out = []
    for s in shape_stops.get(shape_id, []):
        if s["id"] not in seen:
            seen.add(s["id"])
            out.append(s["id"])
    return out


def longest_common_run(a, b):
    """Longest contiguous run of stop_ids appearing in the same order in both
    a and b (classic longest-common-substring DP, O(len(a)*len(b)) — trivial
    at these sizes, tens of stops per spine)."""
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    best_len, best_end = 0, 0
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
                if dp[i][j] > best_len:
                    best_len, best_end = dp[i][j], i
    return a[best_end - best_len : best_end] if best_len else []


def _geometric_overlap(pts_a, cum_a, pts_b):
    """Sample shape A every ~50m; for each sample, find min distance to any
    point on shape B's raw polyline (good enough at these polyline sizes —
    a few hundred points — for a one-time offline pass, not a hot path).
    Returns contiguous runs (in meters along A) where the two shapes stay
    within GEO_EPSILON_M of each other, filtered to >= GEO_MIN_RUN_M long."""
    if not pts_a or not pts_b or cum_a[-1] < GEO_MIN_RUN_M:
        return []
    step = 50
    samples = []
    d = 0.0
    ai = 0
    total = cum_a[-1]
    while d <= total:
        while ai < len(cum_a) - 2 and cum_a[ai + 1] < d:
            ai += 1
        t = 0.0 if cum_a[ai + 1] == cum_a[ai] else (d - cum_a[ai]) / (cum_a[ai + 1] - cum_a[ai])
        lon = pts_a[ai][0] + t * (pts_a[ai + 1][0] - pts_a[ai][0])
        lat = pts_a[ai][1] + t * (pts_a[ai + 1][1] - pts_a[ai][1])
        min_dist = min(_haversine_m((lon, lat), p) for p in pts_b)
        samples.append((d, min_dist <= GEO_EPSILON_M))
        d += step

    runs = []
    run_start = None
    for dist, close in samples:
        if close and run_start is None:
            run_start = dist
        elif not close and run_start is not None:
            if dist - run_start >= GEO_MIN_RUN_M:
                runs.append((run_start, dist))
            run_start = None
    if run_start is not None and total - run_start >= GEO_MIN_RUN_M:
        runs.append((run_start, total))
    return runs


def build():
    shapes_by_route_dir = _load_json("shapesByRouteDir.json")
    shape_stops = _load_json("shapeStops.json")
    shapes = _load_json("shapes.json")

    routes = sorted({key.split("|")[0] for key in shapes_by_route_dir})

    # ---- FOLLOWS: canonical spine per route+direction ----
    follows_order = {}
    canonical_shape_by_route_dir = {}
    for route in routes:
        for direction in DIRECTIONS:
            sid = canonical_shape_id(shapes_by_route_dir, shape_stops, route, direction)
            if sid is None:
                continue
            spine = canonical_spine(shape_stops, sid)
            follows_order[f"{route}|{direction}"] = {stop_id: i for i, stop_id in enumerate(spine)}
            canonical_shape_by_route_dir[f"{route}|{direction}"] = sid

    # ---- SHARES_TRACK: stop-id-run zones between different routes, same direction ----
    shares_track = []
    inspect_rows = []
    for direction in DIRECTIONS:
        route_dirs = [r for r in routes if f"{r}|{direction}" in follows_order]
        for i, ra in enumerate(route_dirs):
            spine_a = list(follows_order[f"{ra}|{direction}"].keys())
            for rb in route_dirs[i + 1 :]:
                spine_b = list(follows_order[f"{rb}|{direction}"].keys())
                run = longest_common_run(spine_a, spine_b)
                if len(run) >= SHARES_TRACK_MIN_RUN:
                    shares_track.append({
                        "route_a": ra, "route_b": rb, "direction": direction,
                        "stop_ids": run, "n_stops": len(run), "source": "stopseq",
                    })
                    inspect_rows.append({
                        "type": "shares_track", "route_a": ra, "route_b": rb, "direction": direction,
                        "n_stops": len(run), "source": "stopseq",
                        "first_stop": run[0], "last_stop": run[-1],
                    })
                else:
                    # geometric fallback — only for pairs the stop-id method missed
                    sid_a = canonical_shape_by_route_dir[f"{ra}|{direction}"]
                    sid_b = canonical_shape_by_route_dir[f"{rb}|{direction}"]
                    shp_a, shp_b = shapes.get(sid_a), shapes.get(sid_b)
                    if not shp_a or not shp_b:
                        continue
                    for start_m, end_m in _geometric_overlap(shp_a["pts"], shp_a["cum"], shp_b["pts"]):
                        shares_track.append({
                            "route_a": ra, "route_b": rb, "direction": direction,
                            "start_m": round(start_m), "end_m": round(end_m),
                            "source": "geometric",  # flagged for manual spot-check — see plan
                        })
                        inspect_rows.append({
                            "type": "shares_track", "route_a": ra, "route_b": rb, "direction": direction,
                            "n_stops": None, "source": "geometric",
                            "first_stop": f"{round(start_m)}m", "last_stop": f"{round(end_m)}m",
                        })

    for key, order in follows_order.items():
        route, direction = key.split("|")
        inspect_rows.append({
            "type": "follows_spine", "route_a": route, "route_b": None, "direction": direction,
            "n_stops": len(order), "source": "stopseq", "first_stop": None, "last_stop": None,
        })

    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "follows_order.json"), "w") as f:
        json.dump(follows_order, f)
    with open(os.path.join(OUTDIR, "shares_track.json"), "w") as f:
        json.dump(shares_track, f, indent=2)
    pl.DataFrame(inspect_rows).write_parquet(os.path.join(OUTDIR, "graph_edges_inspect.parquet"))

    stopseq = [z for z in shares_track if z["source"] == "stopseq"]
    geo = [z for z in shares_track if z["source"] == "geometric"]
    print(f"[graph_edges] {len(follows_order)} FOLLOWS spines "
          f"({len(routes)} routes x up to {len(DIRECTIONS)} directions)")
    print(f"[graph_edges] {len(stopseq)} SHARES_TRACK zones (stop-id run, K>={SHARES_TRACK_MIN_RUN}) "
          f"+ {len(geo)} geometric-fallback zones (flag for manual review)")
    for z in sorted(stopseq, key=lambda z: -z["n_stops"])[:8]:
        print(f"    {z['route_a']}/{z['direction']} <-> {z['route_b']}/{z['direction']}: {z['n_stops']} stops")
    print(f"[graph_edges] wrote {OUTDIR}/follows_order.json, shares_track.json, graph_edges_inspect.parquet")
    return follows_order, shares_track


if __name__ == "__main__":
    build()
