// Bus bunching: unlike subway (event-driven passage at a reference stop),
// buses have no shape/route geometry in this system (ingest/nyc-bus.ts is
// GPS-only by design), so instead we directly measure the tightest spacing
// between same-route buses each tick — the minimum pairwise haversine
// distance, converted to a time gap via the pair's average reported speed.
// One sample per route per tick (when 2+ buses are active on it).
package stats

import (
	"log"
	"math"
)

const earthRadiusM = 6371000.0

func haversine(a, b [2]float64) float64 {
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := toRad(b[1] - a[1])
	dLon := toRad(b[0] - a[0])
	lat1, lat2 := toRad(a[1]), toRad(b[1])
	h := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(h))
}

type BusInput struct {
	Route string
	Pos   [2]float64
	Speed float64
}

// ObserveBuses computes the tightest same-route spacing this tick and feeds
// it into the same key/baseline system headway.go uses, under key "ROUTE|bus"
// so it's distinguishable from subway's "ROUTE|N"/"ROUTE|S" keys.
func (h *HeadwayDetector) ObserveBuses(buses []BusInput, ts int64) MinBusGap {
	byRoute := map[string][]BusInput{}
	for _, b := range buses {
		byRoute[b.Route] = append(byRoute[b.Route], b)
	}
	best := MinBusGap{DistanceM: math.Inf(1)}
	for route, group := range byRoute {
		if len(group) < 2 {
			continue
		}
		minDist := math.Inf(1)
		var avgSpeed float64
		var closestPos [2]float64
		for i := 0; i < len(group); i++ {
			for j := i + 1; j < len(group); j++ {
				d := haversine(group[i].Pos, group[j].Pos)
				if d < minDist {
					minDist = d
					avgSpeed = (group[i].Speed + group[j].Speed) / 2
					closestPos = [2]float64{
						(group[i].Pos[0] + group[j].Pos[0]) / 2,
						(group[i].Pos[1] + group[j].Pos[1]) / 2,
					}
				}
			}
		}
		if avgSpeed < 1 {
			avgSpeed = 1 // floor to avoid a divide-by-near-zero inflating the gap absurdly
		}
		gap := minDist / avgSpeed
		key := route + "|bus"
		bl, ok := h.baselines[key]
		if !ok {
			bl = &Welford{}
			h.baselines[key] = bl
		}
		bl.Add(gap)
		h.recent = append(h.recent, Sample{Ts: ts, Key: key, GapSeconds: gap})
		h.positions[key] = closestPos // midpoint of the tightest pair, for context enrichment
		wasFlagged := h.flagged[key] != nil
		if flag := Evaluate(key, gap, bl); flag != nil {
			h.flagged[key] = flag
			if !wasFlagged {
				h.pending = append(h.pending, *flag) // transition into flagged -> log once
			}
			log.Printf("[ANOMALY] %s %s: gap=%.0fs z=%.2f (mean=%.0fs sd=%.0fs n=%d)",
				flag.Kind, key, flag.GapSeconds, flag.ZScore, flag.Mean, flag.Stddev, flag.SampleN)
		} else {
			h.flagged[key] = nil
		}
		if minDist < best.DistanceM {
			best = MinBusGap{Route: route, DistanceM: minDist, GapSeconds: gap}
		}
	}
	if len(h.recent) > 500 {
		h.recent = h.recent[len(h.recent)-500:]
	}
	return best
}

// MinBusGap reports the single tightest same-route bus spacing seen this
// tick, across all routes — used for a live sanity-check log line.
type MinBusGap struct {
	Route      string
	DistanceM  float64
	GapSeconds float64
}
