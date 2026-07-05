"""GET /context?routeId=&lat=&lon= -- weather + NYC 311 fusion for the Go
analytics service's anomaly annotations. Stdlib-only (http.server), no pip
installs needed. Port 8091.

Scope boundary (see PROJECT_SPEC.md): only public aggregate weather/311 data,
never anything complainant- or rider-identifying. Correlation language only
("nearby", "recent") -- never a causal claim.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import nyc311
import weather

PORT = 8091


def build_context(route_id, lat, lon):
    cond = weather.get_current_conditions()
    complaint_count = nyc311.count_near(lat, lon) if (lat is not None and lon is not None) else 0

    parts = []
    if cond.get("precipitating"):
        parts.append(f"active {cond.get('conditions', 'precipitation').lower()} in the area")
    elif cond.get("conditions"):
        parts.append(f"conditions: {cond['conditions'].lower()}")
    if complaint_count > 0:
        parts.append(f"{complaint_count} bus-stop-shelter complaint(s) filed nearby in the last 72h")

    why = "; ".join(parts) if parts else "no weather or nearby 311 signal available"
    return {
        "routeId": route_id,
        "weather": cond,
        "nearby311Count": complaint_count,
        "why": why,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[analytics-py] {self.address_string()} - {fmt % args}")

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._send_json({"ok": True})
            return

        if parsed.path == "/context":
            route_id = qs.get("routeId", [""])[0]
            try:
                lat = float(qs.get("lat", [None])[0])
                lon = float(qs.get("lon", [None])[0])
            except (TypeError, ValueError):
                lat = lon = None
            self._send_json(build_context(route_id, lat, lon))
            return

        # Single 0-100 "worse for transit" weather scalar, sampled by the Node
        # backend into the prediction ledger as an ETA-model feature.
        if parsed.path == "/weather-score":
            cond = weather.get_current_conditions()
            self._send_json({
                "severity": weather.severity_score(cond),
                "tempF": cond.get("tempF"),
                "precipitating": bool(cond.get("precipitating")),
                "conditions": cond.get("conditions"),
            })
            return

        self._send_json({"error": "not found"}, status=404)


if __name__ == "__main__":
    print(f"[analytics-py] listening on :{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
