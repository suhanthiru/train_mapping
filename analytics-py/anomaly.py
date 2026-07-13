"""Anomaly detection on top of MTA historical baselines (roadmap: the anomaly
system). A live train is "anomalous" when it runs materially slower than what
history says to expect — and, unlike a bare ETA miss, an anomaly is CROSS-
REFERENCED against known disruptions (Service Alerts) and the line's dominant
delay cause (Delay-Causing Incidents) so the ops layer can say *why*.

Two expected-timing baselines from mta_history:
  * schedule (g8es-h7gb): expected seconds for a from->to hop -> per-hop
    deviation = observed - scheduled.
  * end-to-end runtime percentiles (sp9g-mzjh): expected p50/p75 for a whole
    stop_path -> trip is anomalous when observed running time > p75 (a
    distribution-aware threshold, not a fixed number).

This is the disruption-driven signal that aggregate pretraining can't fix (see
eval_pretrain.py: v2's 5-10/10+ min buckets stay biased late) — the ETA models
answer "how long normally", the anomaly detector answers "is this NOT normal".

Pure/offline-safe: reads cached mta_history baselines + an in-memory alert index;
no writes, no ledger mutation. Used by app.py's /anomaly endpoint and the
historical replay sanity check in __main__.
"""
from datetime import datetime

import alert_index
import mta_history

# map an hour-of-day to a runtime time_period — tokens match mta_history.norm_period
# (lowercase) so score_trip's baseline lookup keys line up with runtime_baseline().
_PERIODS = [("overnight", 0, 6), ("am peak", 6, 10), ("midday", 10, 16),
            ("pm peak", 16, 20), ("evening", 20, 24)]

# how much slower than expected before we call it an anomaly
HOP_DEVIATION_RATIO = 1.5     # observed hop >= 1.5x scheduled
HOP_DEVIATION_MIN_S = 45      # ...and at least this many seconds over (noise floor)


def _day_type(ts):
    wd = datetime.fromtimestamp(ts).weekday()  # 0=Mon..6=Sun
    return "Saturday" if wd == 5 else "Sunday" if wd == 6 else "Weekday"


def _time_period(ts):
    h = datetime.fromtimestamp(ts).hour
    for name, lo, hi in _PERIODS:
        if lo <= h < hi:
            return name
    return "midday"


# ------------------------------------------------------------------ alert index
# Shared alert_index (roadmap P3) with the ANOMALY window (wide: "is this
# slowness plausibly explained by an alert"). _alert_idx stays as a module
# seam so tests can inject a canned index.

_alert_idx = None


def _alerts():
    """route_id -> sorted alert timestamps: ledger snapshots + Open-Data history."""
    global _alert_idx
    if _alert_idx is None:
        _alert_idx = alert_index.build(with_history=True)
    return _alert_idx


def _alert_active(route_id, ts, window=alert_index.ANOMALY_WINDOW_S):
    return bool(alert_index.active(_alerts(), route_id, ts, window=window))


# ------------------------------------------------------------------ scorers

def score_hop(route_id, from_stop, to_stop, ts, observed_sec):
    """Is a single from->to hop running anomalously slow vs its scheduled time?
    Returns a dict with the deviation, a bool, and disruption context."""
    day_type = _day_type(ts)
    sched = mta_history.sched_hop_sec(from_stop, to_stop, day_type)
    out = {
        "route_id": route_id, "from_stop": from_stop, "to_stop": to_stop,
        "day_type": day_type, "observed_sec": round(observed_sec, 1),
        "scheduled_sec": sched, "deviation_sec": None, "is_anomaly": False,
        "alert_active": _alert_active(route_id, ts),
        "likely_cause": mta_history.top_incident_cause(route_id, ts),
    }
    if sched:
        dev = observed_sec - sched
        out["deviation_sec"] = round(dev, 1)
        out["is_anomaly"] = bool(observed_sec >= sched * HOP_DEVIATION_RATIO
                                 and dev >= HOP_DEVIATION_MIN_S)
    return out


def score_trip(stop_path_id, ts, observed_runtime_sec):
    """Is a whole stop_path trip anomalously slow vs its historical p75?
    Distribution-aware: the threshold is the 75th-percentile runtime for this
    path under this day-type + time-period, not a fixed number."""
    day_type = _day_type(ts)
    period = _time_period(ts)
    base = mta_history.runtime_baseline().get(f"{stop_path_id}|{day_type}|{period}")
    out = {
        "stop_path_id": stop_path_id, "day_type": day_type, "time_period": period,
        "observed_runtime_sec": round(observed_runtime_sec, 1),
        "expected_p50_sec": None, "expected_p75_sec": None,
        "is_anomaly": False, "severity": None,
        "likely_cause": mta_history.top_incident_cause(stop_path_id.split("-")[0], ts),
    }
    if base:
        out["expected_p50_sec"] = round(base["p50_sec"], 1)
        out["expected_p75_sec"] = round(base["p75_sec"], 1)
        if observed_runtime_sec > base["p75_sec"]:
            out["is_anomaly"] = True
            over = observed_runtime_sec - base["p75_sec"]
            # severity relative to how far past p75 (p75-p50 as a rough spread unit)
            spread = max(1.0, base["p75_sec"] - base["p50_sec"])
            out["severity"] = round(over / spread, 2)
    return out


# ------------------------------------------------------------------ replay test

if __name__ == "__main__":
    # Sanity replay: fabricate an obviously slow hop and an obviously slow trip
    # and confirm both flag, with cause context attached. (A full ledger replay
    # against a known Service Alert window is the deeper check in eval/verify.)
    import time
    now = int(time.time())
    print("== hop scorer ==")
    # pick a real scheduled hop from the cache
    sched = mta_history.schedule_hop_seconds()
    sample_key = next(iter(sched))
    fs, ts_, day = sample_key.split("|")
    normal = sched[sample_key]
    print("  normal hop:", score_hop("2", fs, ts_, now, normal))
    print("  slow hop:  ", score_hop("2", fs, ts_, now, normal * 3 + 120))

    print("== trip scorer ==")
    base = mta_history.runtime_baseline()
    pk = next(iter(base))
    pid = pk.split("|")[0]
    exp = base[pk]
    print(f"  baseline {pk}: p50={exp['p50_sec']:.0f}s p75={exp['p75_sec']:.0f}s")
    print("  normal trip:", score_trip(pid, now, exp["p50_sec"]))
    print("  slow trip:  ", score_trip(pid, now, exp["p75_sec"] * 1.5))
