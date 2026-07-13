"""MTA historical Open Data (Socrata) — the shared ingestion + cache layer that
feeds three consumers: (1) ETA pretraining (build_pretrain.py), (2) the anomaly
detector (anomaly.py), and (3) the prediction/ops surface. Same design as
mta_ridership.py: stdlib-only Socrata pulls, disk cache with a TTL, blocking
`ensure_*` loaders for offline/training use, zero API keys.

Every dataset's schema + value formats were verified LIVE against the Socrata
JSON endpoints on 2026-07-12 (never assumed from memory — same convention as
mta_ridership.py). Verified facts baked into the parsers below:

  sp9g-mzjh  End-to-End Running Times ("Beginning 2019")
    average_actual_runtime is in MINUTES; _25/_50/_75_percentile_runtime too.
    schedule_day_type in {Weekday, Saturday, Sunday}; time_period in
    {AM peak, Midday, PM peak, Evening, Overnight} (note lowercase "peak").
    origin/destination/... station ids are PARENT gtfs ids (numeric for the
    A division e.g. "120", letter+num for the B division e.g. "R01"); direction
    is a separate single letter N/S. stop_path_id e.g. "2-S-120-247-62".

  tdmq-asac  Subway Paths ("Beginning 2019")
    one row per stop on a path: station_id (parent gtfs), stop_order (1-based),
    joinable to sp9g-mzjh on stop_path_id. `distance` is WHOLE-PATH miles
    (repeated per row) — there is NO per-hop distance here (allocation happens
    in build_pretrain using the tracker's own segments.distance_m).

  g8es-h7gb  Subway Schedules 2026
    one row per scheduled stop: gtfs_stop_id (parent), direction, stop_order,
    train_id (identifies a trip), departure_time / arrival_time (ISO), line,
    service_date. Scheduled hop seconds = departure delta between consecutive
    stops of the same (service_date, train_id).

  5f5g-n3cz  Stations and Complexes
    structure_type in {Subway, Elevated, Open Cut, Viaduct, At Grade,
    Embankment}; gtfs_stop_ids parent id(s) (occasionally pipe/space delimited).
    Mapped to the tracker's elevation vocab {underground, surface, elevated}.

  7kct-peq7  Service Alerts ("Beginning April 2020") + 3h5b-5ktz (2012-2020)
    date (ISO), agency (e.g. "NYCT Subway"), affected (pipe-delimited routes,
    e.g. "2 | 3"), status_label, header.

  g937-7k7c  Subway Delay-Causing Incidents ("Beginning 2020")
    monthly counts by line, day_type (1=weekday, 2=weekend), reporting_category
    (Crew Availability / External Factors / Infrastructure & Equipment /
    Operating Conditions / Planned ROW Work / Police & Medical). Aggregate — a
    delay-risk PRIOR + anomaly cause labels, not per-hop training rows.
"""
import os
from datetime import datetime, timezone

import socrata

RUNTIMES_ID = "sp9g-mzjh"
PATHS_ID = "tdmq-asac"
SCHEDULE_ID = "g8es-h7gb"
STRUCTURE_ID = "5f5g-n3cz"
ALERTS_ID = "7kct-peq7"
ALERTS_HIST_ID = "3h5b-5ktz"
INCIDENTS_ID = "g937-7k7c"

# Fetch/paging/caching live in socrata.py (shared with mta_ridership); this
# module keeps only the dataset-specific parsing + derived views.

# Schedules are huge (one service day ~200k rows). Bound the pull to a small,
# representative set of recent service dates spanning the three day types, then
# aggregate to median hop-seconds. Documented sampling choice (same spirit as
# mta_ridership's 8-week lookback). Dates are auto-discovered (latest available
# Weekday/Saturday/Sunday) so they never go stale; overridable via env for a
# pinned or fuller pull.
SCHEDULE_SERVICE_DATES = [d for d in os.environ.get("SCHEDULE_SERVICE_DATES", "").split(",") if d.strip()]

# structure_type -> tracker elevation vocab (shared/types.ts: underground|surface|elevated)
_STRUCTURE_TO_ELEV = {
    "subway": "underground",
    "tunnel": "underground",
    "elevated": "elevated",
    "viaduct": "elevated",
    "open cut": "surface",
    "at grade": "surface",
    "embankment": "surface",
}

# thin aliases onto the shared client — every builder below uses these
_get = socrata.get
_get_all = socrata.get_all
_cached = socrata.cached
_size = socrata.size
probe = socrata.probe


def _iso_to_epoch(s):
    if not s:
        return None
    try:
        # Socrata floating timestamps have no tz; treat as UTC-naive epoch.
        return int(datetime.fromisoformat(s.replace("Z", "")).replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return None


def _suffix(station_id, direction):
    """Reconstruct the tracker's direction-suffixed runtime stop id
    (parent "120" + "S" -> "120S"), matching segments.from_stop / to_stop."""
    d = (direction or "").strip().upper()
    d = d[0] if d else ""
    return f"{station_id}{d}" if d in ("N", "S") else str(station_id)


# ---------------------------------------------------------------- running times

def runtimes():
    """List of per-path end-to-end runtime rows (one per month × day_type ×
    time_period), numbers coerced. Runtime fields are in MINUTES."""
    def build():
        probe(RUNTIMES_ID)
        rows = _get_all(RUNTIMES_ID, {"$select":
            "stop_path_id,line,direction,schedule_day_type,time_period,"
            "average_actual_runtime,_50th_percentile_runtime,_75th_percentile_runtime,"
            "distance,average_speed,number_of_stops,actual_trains,month"})
        out = []
        for r in rows:
            try:
                out.append({
                    "stop_path_id": r["stop_path_id"],
                    "line": r["line"], "direction": r["direction"],
                    "day_type": r["schedule_day_type"], "time_period": r["time_period"],
                    "avg_min": float(r["average_actual_runtime"]),
                    "p50_min": float(r.get("_50th_percentile_runtime") or r["average_actual_runtime"]),
                    "p75_min": float(r.get("_75th_percentile_runtime") or r["average_actual_runtime"]),
                    "distance_mi": float(r.get("distance") or 0.0),
                    "avg_speed": float(r.get("average_speed") or 0.0),
                    "n_stops": int(float(r.get("number_of_stops") or 0)),
                    "n_trains": int(float(r.get("actual_trains") or 0)),
                })
            except (KeyError, TypeError, ValueError):
                continue
        return out
    return _cached("runtimes", build)


def paths_index():
    """{stop_path_id: {line, direction, stops: [ordered parent station_ids],
    n_stops, distance_mi}}. The ordered stop sequence lets build_pretrain split
    a path into consecutive hops."""
    def build():
        probe(PATHS_ID)
        rows = _get_all(PATHS_ID, {"$select":
            "stop_path_id,line,direction,station_id,stop_order,distance,number_of_stops",
            "$order": "stop_path_id,stop_order"})
        idx = {}
        for r in rows:
            pid = r.get("stop_path_id")
            if not pid or r.get("station_id") is None:
                continue
            e = idx.setdefault(pid, {
                "line": r.get("line"), "direction": r.get("direction"),
                "distance_mi": float(r.get("distance") or 0.0),
                "n_stops": int(float(r.get("number_of_stops") or 0)),
                "_ord": [],
            })
            try:
                e["_ord"].append((int(float(r["stop_order"])), r["station_id"]))
            except (TypeError, ValueError):
                continue
        for e in idx.values():
            e["stops"] = [sid for _, sid in sorted(e["_ord"])]
            del e["_ord"]
        return idx
    return _cached("paths_index", build)


def norm_period(p):
    """Normalize the source dataset's INCONSISTENT time_period casing
    ("AM peak"/"PM peak" but lowercase "midday"/"evening"/"overnight") to a
    single lowercase token, so keys built here match lookups everywhere."""
    return (p or "").strip().lower()


_baseline_memo = {"ts": None, "data": None}


def runtime_baseline():
    """Anomaly baseline: {(stop_path_id, day_type, norm_period):
    {p50_sec, p75_sec, avg_sec}} — the expected end-to-end running time
    distribution a live trip is compared against.

    Memoized: this sits on the anomaly-scoring hot path (called per /anomaly
    request), and rebuilding a ~140k-row dict per call was the dominant cost.
    Invalidates when the underlying runtimes() cache blob is refreshed."""
    src_ts = socrata.cache_ts("runtimes")
    if _baseline_memo["data"] is not None and _baseline_memo["ts"] == src_ts:
        return _baseline_memo["data"]
    out = {}
    for r in runtimes():
        key = f"{r['stop_path_id']}|{r['day_type']}|{norm_period(r['time_period'])}"
        out[key] = {"p50_sec": r["p50_min"] * 60, "p75_sec": r["p75_min"] * 60,
                    "avg_sec": r["avg_min"] * 60}
    # runtimes() populated the socrata mem-cache as a side effect — key on it
    _baseline_memo.update({"ts": socrata.cache_ts("runtimes"), "data": out})
    return out


# ---------------------------------------------------------------- structure/elev

def structure_elevation():
    """{parent_gtfs_stop_id: 'underground'|'surface'|'elevated'} from structure
    type — the real categorical replacement for the hardcoded elevation."""
    def build():
        probe(STRUCTURE_ID)
        rows = _get_all(STRUCTURE_ID, {"$select": "structure_type,gtfs_stop_ids"})
        out = {}
        for r in rows:
            elev = _STRUCTURE_TO_ELEV.get((r.get("structure_type") or "").strip().lower())
            if not elev:
                continue
            for sid in _split_ids(r.get("gtfs_stop_ids")):
                out[sid] = elev
        return out
    return _cached("structure_elevation", build)


def _split_ids(raw):
    if not raw:
        return []
    for sep in ("|", ";", ","):
        raw = raw.replace(sep, " ")
    return [s.strip() for s in raw.split() if s.strip()]


def elevation(stop_id):
    """Elevation for a runtime stop id (suffixed or parent). Falls back to
    'underground' — the same default the ledger/server use (server/index.ts)."""
    m = structure_elevation()
    parent = stop_id[:-1] if stop_id and stop_id[-1] in "NS" else stop_id
    return m.get(parent, "underground")


# ---------------------------------------------------------------- alerts

def alerts():
    """Historical subway service alerts as (route_id, ts) pairs — merged into
    train_eta's in-memory alert index so alert_active gets years of coverage
    (never written into the production ledger)."""
    def build():
        pairs = []
        for rid in (ALERTS_ID, ALERTS_HIST_ID):
            try:
                probe(rid)
                rows = _get_all(rid, {"$select": "date,agency,affected"})
            except Exception as e:
                print(f"[history] alerts {rid} skipped:", e)
                continue
            for r in rows:
                agency = (r.get("agency") or "").lower()
                if "subway" not in agency and "nyct" not in agency:
                    continue
                ts = _iso_to_epoch(r.get("date"))
                if ts is None:
                    continue
                for route in _split_routes(r.get("affected")):
                    pairs.append([route, ts])
        return pairs
    return _cached("alerts", build)


def _split_routes(raw):
    if not raw:
        return []
    return [s.strip() for s in raw.split("|") if s.strip()]


# ---------------------------------------------------------------- incidents

def incident_prior():
    """{(line, day_type_num): {category: incidents_per_month}} — a delay-risk
    prior + anomaly cause labels. day_type_num: 1=weekday, 2=weekend."""
    def build():
        probe(INCIDENTS_ID)
        rows = _get_all(INCIDENTS_ID, {"$select":
            "line,day_type,reporting_category,incidents,month"})
        agg = {}
        counts = {}
        for r in rows:
            try:
                key = f"{r['line']}|{int(float(r['day_type']))}"
                cat = r["reporting_category"]
                n = float(r["incidents"])
            except (KeyError, TypeError, ValueError):
                continue
            agg.setdefault(key, {}).setdefault(cat, 0.0)
            agg[key][cat] += n
            counts[key] = counts.get(key, 0) + 1
        # average per reporting month so the prior is a rate, not a raw sum
        months = {}
        for r in rows:
            try:
                months.setdefault(f"{r['line']}|{int(float(r['day_type']))}", set()).add(r["month"])
            except (KeyError, TypeError, ValueError):
                continue
        for key, cats in agg.items():
            nm = max(1, len(months.get(key, {1})))
            for cat in cats:
                cats[cat] = round(cats[cat] / nm, 2)
        return agg
    return _cached("incident_prior", build)


def top_incident_cause(line, when_ts):
    """The dominant delay cause category for a line/day-type — attached to an
    anomaly so the ops layer can say *why* a train is likely late."""
    prior = incident_prior()
    dow = datetime.fromtimestamp(when_ts).weekday()  # 0=Mon..6=Sun
    day_type = 2 if dow >= 5 else 1
    cats = prior.get(f"{line}|{day_type}")
    if not cats:
        return None
    cause, rate = max(cats.items(), key=lambda kv: kv[1])
    return {"cause": cause, "incidents_per_month": rate}


# ---------------------------------------------------------------- schedule

def schedule_hop_seconds():
    """{(from_stop_suffixed, to_stop_suffixed, day_type): median_sched_sec} over
    a bounded set of representative service dates. Also the scheduled-arrival
    baseline the anomaly detector uses. day_type in {Weekday, Saturday, Sunday}."""
    def build():
        probe(SCHEDULE_ID)
        buckets = {}
        dates = SCHEDULE_SERVICE_DATES or _recent_service_dates()
        for sdate in dates:
            sdate = sdate.strip()
            if not sdate:
                continue
            try:
                rows = _get_all(SCHEDULE_ID, {
                    "$select": "service_date,train_id,direction,stop_order,"
                               "gtfs_stop_id,departure_time,arrival_time,line",
                    "$where": f"service_date='{sdate}T00:00:00.000' AND revenue_service='1'",
                    "$order": "train_id,stop_order",
                })
            except Exception as e:
                print(f"[history] schedule {sdate} skipped:", e)
                continue
            day_type = _weekday_bucket(sdate)
            _accumulate_hops(rows, day_type, buckets)
        # median per (from,to,day_type)
        out = {}
        for key, vals in buckets.items():
            vals.sort()
            out[key] = vals[len(vals) // 2]
        return out
    return _cached("schedule_hops", build)


def _recent_service_dates():
    """Auto-pick the latest available Weekday, Saturday and Sunday service dates
    so the bounded schedule pull never goes stale as the dataset advances."""
    rows = _get(SCHEDULE_ID, {"$select": "service_date", "$group": "service_date",
                              "$order": "service_date DESC", "$limit": "40"})
    picked, want = {}, {"Weekday", "Saturday", "Sunday"}
    for r in rows:
        raw = (r.get("service_date") or "")[:10]
        if not raw:
            continue
        b = _weekday_bucket(raw)
        if b in want and b not in picked:
            picked[b] = raw
        if len(picked) == len(want):
            break
    if picked:
        print(f"[history] schedule service dates: {picked}")
    return list(picked.values())


def _weekday_bucket(sdate):
    try:
        wd = datetime.fromisoformat(sdate).weekday()
    except Exception:
        return "Weekday"
    return "Saturday" if wd == 5 else "Sunday" if wd == 6 else "Weekday"


def _accumulate_hops(rows, day_type, buckets):
    """Difference consecutive same-trip stops into hop seconds."""
    prev = None
    for r in rows:
        tid = r.get("train_id")
        t = _iso_to_epoch(r.get("departure_time") or r.get("arrival_time"))
        stop = _suffix(r.get("gtfs_stop_id"), r.get("direction"))
        if t is None or not stop:
            prev = None
            continue
        if prev and prev["tid"] == tid:
            dt = t - prev["t"]
            if 2 <= dt <= 1800:
                key = f"{prev['stop']}|{stop}|{day_type}"
                buckets.setdefault(key, []).append(dt)
        prev = {"tid": tid, "t": t, "stop": stop}


def sched_hop_sec(from_stop, to_stop, day_type):
    return schedule_hop_seconds().get(f"{from_stop}|{to_stop}|{day_type}")


# ---------------------------------------------------------------- self-test

if __name__ == "__main__":
    print("== schema probes ==")
    for rid in (RUNTIMES_ID, PATHS_ID, SCHEDULE_ID, STRUCTURE_ID, ALERTS_ID, INCIDENTS_ID):
        try:
            print(f"  {rid}: {probe(rid)}")
        except Exception as e:
            print(f"  {rid}: PROBE FAILED — {e}")
    print("== builds (cached after first run) ==")
    print("  runtimes:", _size(runtimes()))
    print("  paths_index:", _size(paths_index()))
    print("  structure_elevation:", _size(structure_elevation()))
    print("  alerts:", _size(alerts()))
    print("  incident_prior:", _size(incident_prior()))
    print("  schedule_hops:", _size(schedule_hop_seconds()))
