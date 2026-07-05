// Kalman-filter sidecar for the transit tracker (PROJECT_SPEC / analytics
// roadmap Phase 2). A 1D constant-velocity filter that estimates each vehicle's
// TRUE position + velocity along its track from the noisy per-tick anchored
// measurement, and reports a covariance (uncertainty). This is the principled
// replacement for Node's hand-rolled continuity clamp — Node calls POST /filter
// each push tick and falls back to the clamp if this service is down.
//
// State x = [d, v]  (distance-along-shape metres, velocity m/s)
//   predict: d += v*dt ; P = F P Fᵀ + Q          F = [[1,dt],[0,1]]
//   update:  y = z - d ; S = P00 + R ; K = P[:,0]/S ; x += K y ; P = (I-KH)P
// Outliers (|y| > GATE) get an inflated R so a feed teleport can't yank the
// estimate — the same job the clamp did, done statistically.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

// ---- tuning constants (tune against /stats on live data) ----
const SIGMA_A: f64 = 1.5; // process accel noise std (m/s^2)
const MEAS_VAR: f64 = 1600.0; // measurement variance (m^2) ~ 40 m std
const GATE: f64 = 200.0; // innovation gate (m); beyond this the measurement is an outlier
const OUTLIER_R_MULT: f64 = 100.0; // inflate R for gated outliers (soft reject)
const MAX_DT: f64 = 120.0; // cap dt (s) so a long gap can't blow up the covariance
const PRUNE_AGE: i64 = 900; // drop tracks unseen this long (s) — mirrors Node's 15 min
const MAX_V: f64 = 25.0; // subway speed ceiling (m/s)
const INNOV_KEEP: usize = 8000; // rolling window for /stats

#[derive(Clone)]
struct KState {
    d: f64,
    v: f64,
    p: [[f64; 2]; 2],
    last_ts: i64,
    last_z: f64, // last raw measurement, for the realized-speed comparison
}

#[derive(Deserialize)]
struct Meas {
    id: String,
    #[serde(rename = "measuredDist")]
    measured_dist: f64,
    ts: i64,
}

#[derive(Serialize)]
struct Filtered {
    id: String,
    #[serde(rename = "filteredDist")]
    filtered_dist: f64,
    velocity: f64,
    variance: f64,
}

struct Filter {
    tracks: HashMap<String, KState>,
    pos_innov: VecDeque<f64>, // |measured - predicted| position error (m)
    spd_innov: VecDeque<f64>, // |realized - predicted| speed error (m/s) vs the 5.72 baseline
    max_ts: i64,
}

fn push_bounded(dq: &mut VecDeque<f64>, val: f64) {
    dq.push_back(val);
    if dq.len() > INNOV_KEEP {
        dq.pop_front();
    }
}

impl Filter {
    fn new() -> Self {
        Filter {
            tracks: HashMap::new(),
            pos_innov: VecDeque::new(),
            spd_innov: VecDeque::new(),
            max_ts: 0,
        }
    }

    fn step(&mut self, m: &Meas) -> Filtered {
        if m.ts > self.max_ts {
            self.max_ts = m.ts;
        }
        let z = m.measured_dist;

        let new_state = match self.tracks.get(&m.id).cloned() {
            None => KState {
                d: z,
                v: 0.0,
                p: [[MEAS_VAR, 0.0], [0.0, 400.0]], // high initial velocity uncertainty
                last_ts: m.ts,
                last_z: z,
            },
            Some(s) => {
                let mut dt = (m.ts - s.last_ts) as f64;
                if dt < 0.0 {
                    dt = 0.0;
                }
                if dt > MAX_DT {
                    dt = MAX_DT;
                }

                // --- predict ---
                let d_pred = s.d + s.v * dt;
                let v_pred = s.v;
                let p = s.p;
                // FP  (F = [[1,dt],[0,1]])
                let fp = [
                    [p[0][0] + dt * p[1][0], p[0][1] + dt * p[1][1]],
                    [p[1][0], p[1][1]],
                ];
                // (FP)Fᵀ  (Fᵀ = [[1,0],[dt,1]])
                let mut pp = [
                    [fp[0][0] + fp[0][1] * dt, fp[0][1]],
                    [fp[1][0] + fp[1][1] * dt, fp[1][1]],
                ];
                // + Q  (accel-noise process model)
                let sa2 = SIGMA_A * SIGMA_A;
                let dt2 = dt * dt;
                let dt3 = dt2 * dt;
                let dt4 = dt2 * dt2;
                pp[0][0] += sa2 * dt4 / 4.0;
                pp[0][1] += sa2 * dt3 / 2.0;
                pp[1][0] += sa2 * dt3 / 2.0;
                pp[1][1] += sa2 * dt2;

                // --- update ---
                let y = z - d_pred; // innovation
                push_bounded(&mut self.pos_innov, y.abs());
                if dt > 0.0 {
                    let realized_v = (z - s.last_z) / dt;
                    push_bounded(&mut self.spd_innov, (realized_v - v_pred).abs());
                }
                // soft gate: inflate R for outliers so a teleport barely moves us
                let r = if y.abs() > GATE {
                    MEAS_VAR * OUTLIER_R_MULT
                } else {
                    MEAS_VAR
                };
                let s_inn = pp[0][0] + r;
                let k0 = pp[0][0] / s_inn;
                let k1 = pp[1][0] / s_inn;
                let d_new = d_pred + k0 * y;
                let mut v_new = v_pred + k1 * y;
                if v_new < 0.0 {
                    v_new = 0.0;
                }
                if v_new > MAX_V {
                    v_new = MAX_V;
                }
                // P = (I - K H) P'   (H = [1,0])
                let np = [
                    [(1.0 - k0) * pp[0][0], (1.0 - k0) * pp[0][1]],
                    [-k1 * pp[0][0] + pp[1][0], -k1 * pp[0][1] + pp[1][1]],
                ];
                KState {
                    d: d_new,
                    v: v_new,
                    p: np,
                    last_ts: m.ts,
                    last_z: z,
                }
            }
        };

        let out = Filtered {
            id: m.id.clone(),
            filtered_dist: new_state.d,
            velocity: new_state.v,
            variance: new_state.p[0][0],
        };
        self.tracks.insert(m.id.clone(), new_state);
        out
    }

    fn prune(&mut self) {
        let cutoff = self.max_ts - PRUNE_AGE;
        self.tracks.retain(|_, s| s.last_ts >= cutoff);
    }

    fn stats(&self) -> serde_json::Value {
        let stat = |dq: &VecDeque<f64>| -> (f64, f64) {
            let n = dq.len();
            if n == 0 {
                return (0.0, 0.0);
            }
            let mean = dq.iter().sum::<f64>() / n as f64;
            let mut v: Vec<f64> = dq.iter().cloned().collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            (mean, v[n / 2])
        };
        let (pos_mean, pos_med) = stat(&self.pos_innov);
        let (spd_mean, spd_med) = stat(&self.spd_innov);
        serde_json::json!({
            "tracked": self.tracks.len(),
            "posInnovSamples": self.pos_innov.len(),
            "posInnovMeanM": pos_mean,
            "posInnovMedianM": pos_med,
            "speedInnovSamples": self.spd_innov.len(),
            "speedInnovMeanMps": spd_mean,
            "speedInnovMedianMps": spd_med,
        })
    }
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let ct = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let cors = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
    Response::from_string(body).with_header(ct).with_header(cors)
}

fn main() {
    let addr = "0.0.0.0:8092";
    let server = Server::http(addr).expect("failed to bind :8092");
    eprintln!("[kalman-rs] listening on {addr}");

    let mut filter = Filter::new();
    let mut req_count: u64 = 0;

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let path = request.url().split('?').next().unwrap_or("").to_string();

        let resp = match (&method, path.as_str()) {
            (Method::Get, "/health") => json_response(
                serde_json::json!({"ok": true, "tracked": filter.tracks.len()}).to_string(),
            ),
            (Method::Get, "/stats") => json_response(filter.stats().to_string()),
            (Method::Post, "/filter") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                match serde_json::from_str::<Vec<Meas>>(&body) {
                    Ok(measurements) => {
                        let out: Vec<Filtered> =
                            measurements.iter().map(|m| filter.step(m)).collect();
                        req_count += 1;
                        if req_count % 20 == 0 {
                            filter.prune();
                        }
                        json_response(serde_json::to_string(&out).unwrap())
                    }
                    Err(e) => json_response(
                        serde_json::json!({"error": format!("bad body: {e}")}).to_string(),
                    ),
                }
            }
            _ => json_response(serde_json::json!({"error": "not found"}).to_string()),
        };
        let _ = request.respond(resp);
    }
}
