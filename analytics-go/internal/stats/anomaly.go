// Anomaly thresholding: a statistical rule (z-score) once a baseline is
// meaningful, plus an absolute-floor rule that works from the very first
// sample (covers cold start — a route with zero history shouldn't have to
// wait for false-negative-prone thin statistics before flagging an obvious
// problem). This pairing (statistics + a sane deterministic floor) is a
// standard pattern in production alerting to avoid both cold-start blindness
// and alert fatigue on thin baselines.
package stats

import "strings"

const MinSamplesForZScore = 20
const ZThreshold = 2.5

// Live-data calibration note (verified this session): using straight-line
// (haversine) bus-to-bus distance systematically UNDERESTIMATES true
// road-following distance in a dense street grid, so a naive 180s floor
// flagged nearly every active route as "bunching" — not a useful signal.
// Tightened to 45s based on observed gap distributions across ~30 live
// routes (most sat in the 5-110s range); this is a starting point, not a
// final tuning — see PROJECT_SPEC.md's note on the multi-hour observation
// window needed before thresholds are truly trustworthy.
const BusBunchFloorSeconds = 45
const SubwayGapFloorSeconds = 900 // >15min between trains = a service gap, regardless of baseline

type Flag struct {
	Key        string
	Kind       string // "bunching" | "gap"
	GapSeconds float64
	ZScore     float64
	Mean       float64
	Stddev     float64
	SampleN    int
}

// Evaluate checks one new gap sample against the floor rules and (once the
// baseline has enough samples) the statistical z-score rule. Returns nil if
// nothing is flagged.
func Evaluate(key string, gap float64, bl *Welford) *Flag {
	isBus := strings.HasSuffix(key, "|bus")

	if isBus && gap < BusBunchFloorSeconds {
		return &Flag{Key: key, Kind: "bunching", GapSeconds: gap, SampleN: bl.N()}
	}
	if !isBus && gap > SubwayGapFloorSeconds {
		return &Flag{Key: key, Kind: "gap", GapSeconds: gap, SampleN: bl.N()}
	}

	if bl != nil && bl.N() >= MinSamplesForZScore {
		z := bl.ZScore(gap)
		if z > ZThreshold {
			return &Flag{Key: key, Kind: "gap", GapSeconds: gap, ZScore: z, Mean: bl.Mean(), Stddev: bl.Stddev(), SampleN: bl.N()}
		}
		if z < -ZThreshold {
			return &Flag{Key: key, Kind: "bunching", GapSeconds: gap, ZScore: z, Mean: bl.Mean(), Stddev: bl.Stddev(), SampleN: bl.N()}
		}
	}
	return nil
}
