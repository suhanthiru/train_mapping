// Package geodata loads the SAME preprocessed static GTFS files the Node
// server already generates (D:\train_tracker\data\nyc\*.json — see
// preprocess/nyc.ts) directly off disk, since Go runs on the same machine.
// Provides distance-along-shape -> [lon,lat] (mirrors shared/geo.ts's
// distToLonLat) and reference-stop selection for headway detection.
package geodata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

type Shape struct {
	ID  string       `json:"id"`
	Pts [][2]float64 `json:"pts"`
	Cum []float64    `json:"cum"`
}

type ShapeStop struct {
	ID   string  `json:"id"`
	Dist float64 `json:"dist"`
}

type Route struct {
	ID        string `json:"id"`
	Color     string `json:"color"`
	TextColor string `json:"textColor"`
	ShortName string `json:"shortName"`
	LongName  string `json:"longName"`
}

type Stop struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Pos  [2]float64 `json:"pos"`
}

// Data holds everything loaded once at startup.
type Data struct {
	Shapes         map[string]Shape
	Routes         map[string]Route
	Stops          map[string]Stop
	ShapeStops     map[string][]ShapeStop  // shapeId -> ordered stops-with-dist
	RouteDirShape  map[string]string       // "routeId|N" or "routeId|S" -> default shapeId
	RefStopByRoute map[string]string       // "routeId|dir" -> chosen reference stop ID (computed)
	RefStopDist    map[string]float64      // "routeId|dir" -> that stop's distance-along the default shape
}

func loadJSON[T any](path string) (T, error) {
	var v T
	b, err := os.ReadFile(path)
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(b, &v)
	return v, err
}

// Load reads data/nyc/*.json from dataDir and picks a reference stop per
// route+direction (the stop nearest the midpoint of the default shape's
// cumulative distance — a reasonable, simple choice for headway sampling).
// Simplification: uses each route+direction's DEFAULT shape (routeDirShape,
// not every express/local variant) — trains on a variant shape that skips
// the chosen reference stop just won't contribute a sample for that stop,
// which is an acceptable v1 tradeoff (noted in PROJECT_SPEC.md).
func Load(dataDir string) (*Data, error) {
	shapes, err := loadJSON[map[string]Shape](filepath.Join(dataDir, "shapes.json"))
	if err != nil {
		return nil, err
	}
	routes, err := loadJSON[map[string]Route](filepath.Join(dataDir, "routes.json"))
	if err != nil {
		return nil, err
	}
	stops, err := loadJSON[map[string]Stop](filepath.Join(dataDir, "stops.json"))
	if err != nil {
		return nil, err
	}
	shapeStops, err := loadJSON[map[string][]ShapeStop](filepath.Join(dataDir, "shapeStops.json"))
	if err != nil {
		return nil, err
	}
	routeDirShape, err := loadJSON[map[string]string](filepath.Join(dataDir, "routeDirShape.json"))
	if err != nil {
		return nil, err
	}

	d := &Data{
		Shapes:         shapes,
		Routes:         routes,
		Stops:          stops,
		ShapeStops:     shapeStops,
		RouteDirShape:  routeDirShape,
		RefStopByRoute: map[string]string{},
		RefStopDist:    map[string]float64{},
	}

	for key, shapeID := range routeDirShape {
		list := shapeStops[shapeID]
		if len(list) == 0 {
			continue
		}
		sorted := append([]ShapeStop(nil), list...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Dist < sorted[j].Dist })
		mid := sorted[len(sorted)/2]
		d.RefStopByRoute[key] = mid.ID
		d.RefStopDist[key] = mid.Dist
	}

	return d, nil
}

// DistToLonLat converts a distance-along-shape (meters) to [lon,lat],
// mirroring shared/geo.ts's distToLonLat exactly (binary search + lerp).
func (s Shape) DistToLonLat(dist float64) [2]float64 {
	if len(s.Pts) == 0 {
		return [2]float64{0, 0}
	}
	if dist <= 0 {
		return s.Pts[0]
	}
	total := s.Cum[len(s.Cum)-1]
	if dist >= total {
		return s.Pts[len(s.Pts)-1]
	}
	lo, hi := 0, len(s.Cum)-1
	for lo < hi-1 {
		mid := (lo + hi) / 2
		if s.Cum[mid] <= dist {
			lo = mid
		} else {
			hi = mid
		}
	}
	seg := s.Cum[hi] - s.Cum[lo]
	if seg == 0 {
		seg = 1
	}
	t := (dist - s.Cum[lo]) / seg
	return [2]float64{
		s.Pts[lo][0] + t*(s.Pts[hi][0]-s.Pts[lo][0]),
		s.Pts[lo][1] + t*(s.Pts[hi][1]-s.Pts[lo][1]),
	}
}
