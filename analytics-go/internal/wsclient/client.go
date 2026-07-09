// Package wsclient connects to the existing Node transit-tracker server as a
// plain WebSocket client — the exact same "state"/"snapshot" broadcast the
// frontend already consumes. This is why server/index.ts needs zero changes:
// Go just looks like one more viewer.
package wsclient

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

// Vehicle mirrors shared/types.ts's VehicleState. Optional/nullable fields
// are pointers so a missing JSON field and an explicit `null` both decode
// cleanly to nil, matching TypeScript's `?:` / `| null` semantics.
type Vehicle struct {
	ID        string     `json:"id"`
	City      string     `json:"city"`
	Mode      string     `json:"mode"`
	Route     string     `json:"route"`
	Color     string     `json:"color"`
	ShapeID   *string    `json:"shapeId"`
	Dist      float64    `json:"dist"`
	Speed     float64    `json:"speed"`
	Bearing   *float64   `json:"bearing,omitempty"`
	Pos       *[2]float64 `json:"pos,omitempty"`
	Elevation string     `json:"elevation"`
	NextStop  *string    `json:"nextStop,omitempty"`
	Stale     *bool      `json:"stale,omitempty"`
}

// StateMessage mirrors the {type, city, ts, vehicles} shape broadcast by
// server/index.ts's pushTick() (type "state") and sent once on connect
// (type "snapshot", no ts).
type StateMessage struct {
	Type     string    `json:"type"`
	City     string    `json:"city"`
	Ts       int64     `json:"ts"`
	Vehicles []Vehicle `json:"vehicles"`
}

// Run connects to url and calls onState for every decoded state/snapshot
// message, reconnecting with backoff on any error. Blocks until the process
// exits; call in its own goroutine.
func Run(url string, onState func(StateMessage)) {
	backoff := time.Second
	for {
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			log.Printf("[wsclient] dial failed: %v (retry in %s)", err, backoff)
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		log.Printf("[wsclient] connected to %s", url)
		backoff = time.Second

		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[wsclient] read error: %v (reconnecting)", err)
				conn.Close()
				break
			}
			var msg StateMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("[wsclient] bad message: %v", err)
				continue
			}
			if msg.Type == "state" || msg.Type == "snapshot" {
				onState(msg)
			}
		}
	}
}
