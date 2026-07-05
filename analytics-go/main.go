// Streaming anomaly-detection + density service for the transit tracker.
// Connects to the existing Node server (D:\train_tracker\server\index.ts) as
// a plain WebSocket client — identical to what the frontend already does —
// so server/index.ts needs zero changes. See PROJECT_SPEC.md's Scope
// Boundary: this reasons only about public vehicles and aggregate patterns,
// never individuals.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"transit-analytics/internal/geodata"
	"transit-analytics/internal/httpapi"
	"transit-analytics/internal/persist"
	"transit-analytics/internal/stats"
	"transit-analytics/internal/wsclient"
)

// env-configurable (defaults keep native Windows running unchanged; Docker
// overrides via service-name URLs + container paths — see docker-compose.yml).
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

var (
	nodeWSURL = env("NODE_WS_URL", "ws://localhost:8080")
	dataDir   = env("DATA_DIR", `D:\train_tracker\data\nyc`)
	dbPath    = env("DB_PATH", `D:\train_tracker\data\analytics.db`)
	httpAddr  = env("HTTP_ADDR", ":8090")
	pythonURL = env("PYTHON_URL", "http://localhost:8091")
)

// resolvePosition returns [lon,lat] for a vehicle: buses have direct GPS
// (`Pos`); trains resolve via their shape + distance-along-shape, mirroring
// shared/geo.ts's distToLonLat exactly (see geodata.Shape.DistToLonLat).
func resolvePosition(v wsclient.Vehicle, geo *geodata.Data) ([2]float64, bool) {
	if v.Pos != nil {
		return *v.Pos, true
	}
	if v.ShapeID == nil {
		return [2]float64{}, false
	}
	shape, ok := geo.Shapes[*v.ShapeID]
	if !ok {
		return [2]float64{}, false
	}
	return shape.DistToLonLat(v.Dist), true
}

const busColor = "#F0A830" // matches ingest/nyc-bus.ts's BUS_COLOR

// buildWhy produces plain-language annotation text. No weather/311 context
// yet (task 9 adds that via the Python service) — this is the statistical
// "why" only: what was measured vs. what's typical. Uses a plain ASCII
// hyphen separator rather than an em dash to sidestep any source-encoding
// mismatch entirely.
func buildWhy(f stats.Flag, mode string) string {
	noun, plural := "train", "trains"
	if mode == "bus" {
		noun, plural = "bus", "buses"
	}
	coldStart := f.SampleN < stats.MinSamplesForZScore || f.ZScore == 0
	if f.Kind == "bunching" {
		if coldStart {
			return fmt.Sprintf("Two %s only %.0fs apart - closer than expected (baseline still building, n=%d).", plural, f.GapSeconds, f.SampleN)
		}
		return fmt.Sprintf("%s %.0fs apart vs. typical %.0fs (z=%.1f) - bunching.", strings.Title(plural), f.GapSeconds, f.Mean, f.ZScore)
	}
	if coldStart {
		return fmt.Sprintf("%.0fs since the last %s - longer than expected (baseline still building, n=%d).", f.GapSeconds, noun, f.SampleN)
	}
	return fmt.Sprintf("%.0fs since the last %s vs. typical %.0fs (z=%.1f) - possible service gap.", f.GapSeconds, noun, f.Mean, f.ZScore)
}

type pythonContext struct {
	Why string `json:"why"`
}

// fetchPythonContext calls the Python service's /context endpoint. Isolated
// here (own HTTP client, short timeout) so a slow/down Python service can
// never stall the Go service's hot WS-message path — this function is only
// ever called from the separate enrichAnomalies goroutine, never per-tick.
var httpClient = &http.Client{Timeout: 4 * time.Second}

func fetchPythonContext(routeID string, pos [2]float64) (string, error) {
	q := url.Values{}
	q.Set("routeId", routeID)
	q.Set("lon", strconv.FormatFloat(pos[0], 'f', 6, 64))
	q.Set("lat", strconv.FormatFloat(pos[1], 'f', 6, 64))
	resp, err := httpClient.Get(pythonURL + "/context?" + q.Encode())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var ctx pythonContext
	if err := json.NewDecoder(resp.Body).Decode(&ctx); err != nil {
		return "", err
	}
	return ctx.Why, nil
}

// enrichAnomalies runs on its own slow timer, separate from the hot WS-tick
// path: for each currently-flagged anomaly with a known position, calls
// Python for weather/311 context and appends it to the statistical "why"
// text, then overwrites the store with the enriched list. If Python is down
// or slow, this simply doesn't run this cycle — the fast path's Go-only
// anomalies remain visible in the meantime (graceful degradation).
func enrichAnomalies(headway *stats.HeadwayDetector, geo *geodata.Data, store *httpapi.Store) {
	flags := headway.CurrentAnomalies()
	summaries := buildAnomalySummaries(flags, geo)
	for i := range summaries {
		key := summaries[i].RouteID
		if summaries[i].Direction != "" {
			key += "|" + summaries[i].Direction
		} else if summaries[i].Mode == "bus" {
			key += "|bus"
		}
		pos, ok := headway.Position(key)
		if !ok {
			continue
		}
		why, err := fetchPythonContext(summaries[i].RouteID, pos)
		if err != nil || why == "" {
			continue
		}
		summaries[i].Why = summaries[i].Why + " (" + why + ")"
	}
	store.SetAnomalies(summaries)
	log.Printf("[enrich] refreshed %d anomalies with weather/311 context", len(summaries))
}

func buildAnomalySummaries(flags []stats.Flag, geo *geodata.Data) []httpapi.AnomalySummary {
	out := make([]httpapi.AnomalySummary, 0, len(flags))
	for _, f := range flags {
		parts := strings.SplitN(f.Key, "|", 2)
		routeID := parts[0]
		direction, mode, color := "", "subway", "#3FD8FF"
		if len(parts) > 1 {
			if parts[1] == "bus" {
				mode = "bus"
				color = busColor
			} else {
				direction = parts[1]
			}
		}
		if mode == "subway" {
			if r, ok := geo.Routes[routeID]; ok && r.Color != "" {
				color = r.Color
			}
		}
		out = append(out, httpapi.AnomalySummary{
			RouteID: routeID, Direction: direction, Mode: mode, Color: color,
			GapSeconds: f.GapSeconds, ZScore: f.ZScore, Kind: f.Kind,
			Why: buildWhy(f, mode),
		})
	}
	return out
}

// directionFromShapeID mirrors preprocess/nyc.ts's regex (/\.\.?([NS])/):
// NYC shape IDs look like "1..N03R" / "6..S01R" — direction letter right
// after the double-dot.
func directionFromShapeID(shapeID string) string {
	idx := strings.Index(shapeID, "..")
	if idx == -1 || idx+2 >= len(shapeID) {
		return "N"
	}
	if shapeID[idx+2] == 'S' {
		return "S"
	}
	return "N"
}

func main() {
	geo, err := geodata.Load(dataDir)
	if err != nil {
		log.Fatalf("[main] failed to load static geo data: %v", err)
	}
	log.Printf("[main] loaded %d shapes, %d routes, %d reference stops",
		len(geo.Shapes), len(geo.Routes), len(geo.RefStopByRoute))

	db, err := persist.Open(dbPath)
	if err != nil {
		log.Fatalf("[main] failed to open analytics DB: %v", err)
	}
	defer db.Close()

	store := httpapi.NewStore()
	go store.Start(httpAddr)

	headway := stats.NewHeadwayDetector()

	// Seed baselines from disk so anomaly detection is WARM on restart, not
	// cold-starting at n=0 (this is the "constant anomaly detection" ask).
	if seeded, err := db.LoadBaselines(); err != nil {
		log.Printf("[main] baseline seed failed (starting cold): %v", err)
	} else {
		for _, b := range seeded {
			headway.ImportBaseline(b)
		}
		log.Printf("[main] seeded %d baselines from %s", len(seeded), dbPath)
	}

	// On-change occupancy tracking: only write a row when a vehicle's
	// occupancy actually changes (a compact state-transition time series,
	// not a 500-rows-every-4s firehose).
	lastOcc := map[string]string{}

	// Enrich anomalies with weather/311 context + log new anomaly events (own
	// slow timer, never blocks the hot WS path).
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			enrichAnomalies(headway, geo, store)
			if events := headway.DrainNewEvents(); len(events) > 0 {
				if err := db.RecordAnomalyEvents(time.Now().Unix(), events); err != nil {
					log.Printf("[persist] anomaly events: %v", err)
				}
			}
		}
	}()

	// Persist baselines + prune periodically.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := db.SaveBaselines(headway.ExportBaselines()); err != nil {
				log.Printf("[persist] save baselines: %v", err)
			}
			db.Prune()
		}
	}()

	tick := 0
	wsclient.Run(nodeWSURL, func(msg wsclient.StateMessage) {
		busInputs := make([]stats.BusInput, 0, len(msg.Vehicles))
		occRows := make([]persist.OccupancyRow, 0, 32)

		for _, v := range msg.Vehicles {
			p, ok := resolvePosition(v, geo)
			if !ok {
				continue
			}

			// Occupancy transition -> record.
			if v.OccStatus != "" && lastOcc[v.ID] != v.OccStatus {
				lastOcc[v.ID] = v.OccStatus
				pct := 0.0
				if v.OccPct != nil {
					pct = *v.OccPct
				}
				occRows = append(occRows, persist.OccupancyRow{
					Ts: msg.Ts, VehicleID: v.ID, Route: v.Route, Mode: v.Mode,
					Status: v.OccStatus, Pct: pct, Lon: p[0], Lat: p[1],
				})
			}

			if v.Mode == "bus" {
				busInputs = append(busInputs, stats.BusInput{Route: v.Route, Pos: p, Speed: v.Speed})
				continue
			}

			// Subway headway: track remaining distance to this route+
			// direction's reference stop.
			if v.Mode == "subway" && v.ShapeID != nil {
				dir := directionFromShapeID(*v.ShapeID)
				key := v.Route + "|" + dir
				if refDist, ok := geo.RefStopDist[key]; ok {
					remaining := refDist - v.Dist
					headway.Observe(v.ID, key, remaining, msg.Ts)
					if stopID, ok := geo.RefStopByRoute[key]; ok {
						if stop, ok := geo.Stops[stopID]; ok {
							headway.SetPosition(key, stop.Pos)
						}
					}
				}
			}
		}
		headway.ObserveBuses(busInputs, msg.Ts)
		// store's anomalies are updated by the enrich goroutine, not here.

		if err := db.RecordOccupancy(occRows); err != nil {
			log.Printf("[persist] occupancy: %v", err)
		}

		tick++
		if tick%10 == 0 {
			log.Printf("[tick] %d vehicles | occupancy transitions this tick: %d | headway keys: %d | flagged: %d",
				len(msg.Vehicles), len(occRows), len(headway.Keys()), len(headway.CurrentAnomalies()))
		}
	})
}
