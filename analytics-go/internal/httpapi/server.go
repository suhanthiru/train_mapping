// Package httpapi serves the computed anomalies to the frontend, which
// fetches them directly from this service's own port — a separate
// microservice, not proxied through the main Node server.
package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
)

// AnomalySummary is the shape sent to the frontend for the #anomalies panel.
type AnomalySummary struct {
	RouteID    string  `json:"routeId"`
	Direction  string  `json:"direction"`
	Mode       string  `json:"mode"`
	Color      string  `json:"color"`
	GapSeconds float64 `json:"gapSeconds"`
	ZScore     float64 `json:"zscore"`
	Kind       string  `json:"kind"` // "bunching" | "gap"
	Why        string  `json:"why"`
}

// Store holds the latest computed results, guarded by a mutex since it's
// written by the WS-consuming goroutine and read by HTTP handler goroutines.
type Store struct {
	mu        sync.RWMutex
	anomalies []AnomalySummary
}

func NewStore() *Store {
	return &Store{anomalies: []AnomalySummary{}}
}

func (s *Store) SetAnomalies(a []AnomalySummary) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.anomalies = a
}

func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		h(w, r)
	}
}

// Start runs the HTTP server; call in its own goroutine (blocks).
func (s *Store) Start(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/anomalies", withCORS(func(w http.ResponseWriter, r *http.Request) {
		s.mu.RLock()
		defer s.mu.RUnlock()
		json.NewEncoder(w).Encode(s.anomalies)
	}))
	mux.HandleFunc("/health", withCORS(func(w http.ResponseWriter, r *http.Request) {
		s.mu.RLock()
		defer s.mu.RUnlock()
		json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "anomalies": len(s.anomalies),
		})
	}))
	log.Printf("[httpapi] listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[httpapi] server failed: %v", err)
	}
}
