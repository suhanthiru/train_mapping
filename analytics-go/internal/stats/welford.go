// Package stats implements streaming statistics for the headway/bunching
// detector — Welford's online algorithm for mean/variance (O(1) memory per
// key, no raw-sample storage needed), a standard, citable streaming-stats
// technique.
package stats

import "math"

type Welford struct {
	n    int
	mean float64
	m2   float64
}

func (w *Welford) Add(x float64) {
	w.n++
	delta := x - w.mean
	w.mean += delta / float64(w.n)
	delta2 := x - w.mean
	w.m2 += delta * delta2
}

func (w *Welford) N() int      { return w.n }
func (w *Welford) Mean() float64 { return w.mean }

func (w *Welford) Stddev() float64 {
	if w.n < 2 {
		return 0
	}
	return math.Sqrt(w.m2 / float64(w.n-1))
}

func (w *Welford) ZScore(x float64) float64 {
	sd := w.Stddev()
	if sd == 0 {
		return 0
	}
	return (x - w.mean) / sd
}

// State / Restore let the persistence layer save and reload a baseline
// exactly (n, running mean, running sum-of-squared-deviations) so anomaly
// detection survives a process restart instead of cold-starting at n=0.
func (w *Welford) State() (int, float64, float64) { return w.n, w.mean, w.m2 }

func (w *Welford) Restore(n int, mean, m2 float64) {
	w.n = n
	w.mean = mean
	w.m2 = m2
}
