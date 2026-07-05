"""Weather fusion via api.weather.gov (NWS) -- no API key, just a descriptive
User-Agent per NWS usage policy. Caches current conditions in memory and
refreshes on a slow timer (see server.py) since weather doesn't change fast
enough to justify polling more often than every ~10-15 minutes.
"""
import json
import time
import urllib.request

USER_AGENT = "transit-tracker-analytics (contact: suhanthiru@gmail.com)"

# A few representative NYC points -- good enough for a city-wide "is it
# raining right now" signal without a per-vehicle lookup.
STATIONS = {
    "manhattan": (40.7831, -73.9712),
    "brooklyn": (40.6782, -73.9442),
    "queens": (40.7282, -73.7949),
}

_cache = {"ts": 0, "data": None}
CACHE_TTL_SECONDS = 600  # ~10 min


def _http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _nearest_station_id(lat, lon):
    """Two-step NWS API: point -> gridpoint metadata -> observationStations."""
    points = _http_json(f"https://api.weather.gov/points/{lat},{lon}")
    stations_url = points["properties"]["observationStations"]
    stations = _http_json(stations_url)
    features = stations.get("features", [])
    if not features:
        return None
    return features[0]["properties"]["stationIdentifier"]


def _latest_observation(station_id):
    obs = _http_json(f"https://api.weather.gov/stations/{station_id}/observations/latest")
    props = obs.get("properties", {})
    temp_c = (props.get("temperature") or {}).get("value")
    precip_last_hour = (props.get("precipitationLastHour") or {}).get("value")
    text = props.get("textDescription") or ""
    return {
        "tempF": round(temp_c * 9 / 5 + 32, 1) if temp_c is not None else None,
        "conditions": text,
        "precipitating": bool(precip_last_hour) or any(
            k in text.lower() for k in ["rain", "snow", "sleet", "storm", "drizzle"]
        ),
    }


def get_current_conditions():
    """Returns cached current conditions, refreshing if the cache is stale."""
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < CACHE_TTL_SECONDS:
        return _cache["data"]
    try:
        lat, lon = STATIONS["manhattan"]
        station_id = _nearest_station_id(lat, lon)
        if not station_id:
            raise RuntimeError("no observation station found")
        obs = _latest_observation(station_id)
        _cache["data"] = obs
        _cache["ts"] = now
        return obs
    except Exception as e:
        # degrade gracefully -- an anomaly annotation just omits weather context
        return _cache["data"] or {"tempF": None, "conditions": "unavailable", "precipitating": False, "error": str(e)}


# Keyword -> severity contribution (0-100 scale). "Worse for transit" scores
# higher. These are coarse, tunable weights over the NWS textDescription; the
# point is a single monotonic feature the ETA model can learn from, not a
# calibrated meteorological index.
_CONDITION_WEIGHTS = [
    (("blizzard", "ice storm", "freezing"), 90),
    (("snow", "sleet", "wintry"), 70),
    (("thunderstorm", "storm", "squall"), 65),
    (("heavy rain", "heavy"), 60),
    (("rain", "showers"), 40),
    (("drizzle", "light rain"), 25),
    (("fog", "mist", "haze"), 20),
]


def severity_score(cond=None):
    """Collapse current conditions into a single 0-100 'worse for transit'
    scalar. Reuses the cached observation; no extra NWS calls. Combines a
    precipitation base, keyword weighting, and a temperature-extreme bump."""
    if cond is None:
        cond = get_current_conditions()
    text = (cond.get("conditions") or "").lower()

    score = 0
    for keys, weight in _CONDITION_WEIGHTS:
        if any(k in text for k in keys):
            score = max(score, weight)
    # precipitation flag guarantees a floor even if the text is terse
    if cond.get("precipitating") and score < 35:
        score = 35

    # temperature extremes add stress (heat >90F, cold <20F) up to +15
    temp = cond.get("tempF")
    if temp is not None:
        if temp >= 90:
            score += min(15, (temp - 90))
        elif temp <= 20:
            score += min(15, (20 - temp))

    return max(0, min(100, round(score)))


if __name__ == "__main__":
    c = get_current_conditions()
    print(c, "-> severity", severity_score(c))
