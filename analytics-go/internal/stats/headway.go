// Headway/bunching detection: event-driven, using the already-continuous
// `dist` values the interpolator already produces (no ETA projection
// needed). For each route+direction's chosen reference stop, watch each
// approaching train's remaining-distance-to-that-stop; when it crosses from
// positive to <=0 between two ticks, that's a "passage" event. The gap
// between consecutive passages at the same reference stop IS the headway.
//
// Simplification (noted in PROJECT_SPEC.md): uses each route+direction's
// DEFAULT shape only — trains on an express/local variant that skips the
// chosen reference stop simply won't register a passage there. Acceptable
// for a v1 anomaly-detection demo.
package stats

import "log"

type vehicleTrack struct {
	key           string
	lastRemaining float64
}

type Sample struct {
	Ts         int64
	Key        string
	GapSeconds float64
}

// HeadwayDetector tracks passage events and gap statistics per
// "routeId|direction" key, keyed independently for subway (reference-stop
// crossing) and bus (proximity, see bunching.go) modes.
type HeadwayDetector struct {
	vehicles    map[string]*vehicleTrack
	baselines   map[string]*Welford
	lastArrival map[string]int64
	recent      []Sample              // ring of recent samples, for debugging
	flagged     map[string]*Flag      // key -> most recent flag (nil entries pruned on next clean sample)
	positions   map[string][2]float64 // key -> representative [lon,lat], for context enrichment
	pending     []Flag                // newly-transitioned-to-flagged events awaiting DB logging
}

func NewHeadwayDetector() *HeadwayDetector {
	return &HeadwayDetector{
		vehicles:    map[string]*vehicleTrack{},
		baselines:   map[string]*Welford{},
		lastArrival: map[string]int64{},
		flagged:     map[string]*Flag{},
		positions:   map[string][2]float64{},
	}
}

// Position returns a representative [lon,lat] for a key, if known (bus keys
// get this from ObserveBuses each tick; subway keys are looked up separately
// in main.go via the reference stop's static position).
func (h *HeadwayDetector) Position(key string) ([2]float64, bool) {
	p, ok := h.positions[key]
	return p, ok
}

// SetPosition lets main.go record a subway key's reference-stop position
// (looked up once from static geo data, not per-tick).
func (h *HeadwayDetector) SetPosition(key string, pos [2]float64) {
	h.positions[key] = pos
}

// CurrentAnomalies returns a snapshot of all currently-flagged keys.
func (h *HeadwayDetector) CurrentAnomalies() []Flag {
	out := make([]Flag, 0, len(h.flagged))
	for _, f := range h.flagged {
		if f != nil {
			out = append(out, *f)
		}
	}
	return out
}

// BaselineState is one persisted Welford baseline.
type BaselineState struct {
	Key  string
	N    int
	Mean float64
	M2   float64
}

// ExportBaselines snapshots every baseline for persistence.
func (h *HeadwayDetector) ExportBaselines() []BaselineState {
	out := make([]BaselineState, 0, len(h.baselines))
	for key, bl := range h.baselines {
		n, mean, m2 := bl.State()
		out = append(out, BaselineState{Key: key, N: n, Mean: mean, M2: m2})
	}
	return out
}

// ImportBaseline restores a persisted baseline at startup, so detection is
// warm immediately instead of cold-starting.
func (h *HeadwayDetector) ImportBaseline(b BaselineState) {
	bl := &Welford{}
	bl.Restore(b.N, b.Mean, b.M2)
	h.baselines[b.Key] = bl
}

// DrainNewEvents returns anomalies that just transitioned into a flagged
// state since the last drain (for one-row-per-event logging to the DB),
// then clears the pending buffer.
func (h *HeadwayDetector) DrainNewEvents() []Flag {
	out := h.pending
	h.pending = nil
	return out
}

// Observe processes one subway vehicle's current remaining distance to its
// route+direction's reference stop this tick.
func (h *HeadwayDetector) Observe(vehicleID, key string, remaining float64, ts int64) {
	tr, ok := h.vehicles[vehicleID]
	if !ok {
		h.vehicles[vehicleID] = &vehicleTrack{key: key, lastRemaining: remaining}
		return
	}
	if tr.key != key {
		// route/shape reassignment (rare) — reset tracking, don't false-trigger
		tr.key = key
		tr.lastRemaining = remaining
		return
	}
	crossed := tr.lastRemaining > 0 && remaining <= 0
	tr.lastRemaining = remaining
	if !crossed {
		return
	}
	h.recordPassage(key, ts)
}

func (h *HeadwayDetector) recordPassage(key string, ts int64) {
	if lastTs, ok := h.lastArrival[key]; ok {
		gap := float64(ts - lastTs)
		if gap > 0 && gap < 3600 { // ignore >1hr gaps: likely a data hole, not real headway
			bl, ok := h.baselines[key]
			if !ok {
				bl = &Welford{}
				h.baselines[key] = bl
			}
			bl.Add(gap)
			s := Sample{Ts: ts, Key: key, GapSeconds: gap}
			h.recent = append(h.recent, s)
			if len(h.recent) > 500 {
				h.recent = h.recent[len(h.recent)-500:]
			}
			log.Printf("[headway] %s: gap=%.0fs (n=%d mean=%.0fs sd=%.0fs)",
				key, gap, bl.N(), bl.Mean(), bl.Stddev())

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
		}
	}
	h.lastArrival[key] = ts
}

// Baseline exposes the current Welford stats for a key (nil if none yet).
func (h *HeadwayDetector) Baseline(key string) *Welford { return h.baselines[key] }

// SampleCount returns the total number of gap samples recorded across all keys.
func (h *HeadwayDetector) SampleCount() int { return len(h.recent) }

// Keys returns all route+direction keys with at least one recorded baseline.
func (h *HeadwayDetector) Keys() []string {
	keys := make([]string, 0, len(h.baselines))
	for k := range h.baselines {
		keys = append(keys, k)
	}
	return keys
}
