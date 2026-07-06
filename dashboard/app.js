// Analytics dashboard (roadmap Phase 4). Reads the live services and renders
// Chart.js panels. Decoupled from the 3D map — charts, not GPU.
const BACKEND = "http://localhost:8080";
const KALMAN = "http://localhost:8092";
const ANALYTICS = "http://localhost:8091";

const AX = "#8b98a5", GRID = "#1f2937", ACCENT = "#3FD8FF";
Chart.defaults.color = AX;
Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const charts = {};
function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
const axes = (yLabel) => ({
  x: { grid: { color: GRID }, ticks: { autoSkip: true, maxRotation: 45 } },
  y: { grid: { color: GRID }, title: { display: !!yLabel, text: yLabel } },
});

function cards(el, items) {
  el.innerHTML = items
    .map((i) => `<div class="card"><div class="k">${i.k}</div><div class="v">${i.v}</div></div>`)
    .join("");
}

// ---- system panels ----
async function loadCounts() {
  const d = await getJSON(`${BACKEND}/api/prediction-accuracy`);
  const c = d.counts || {};
  cards(document.getElementById("counts"), [
    { k: "predictions", v: (c.predictions ?? 0).toLocaleString() },
    { k: "actuals", v: (c.actuals ?? 0).toLocaleString() },
    { k: "segments", v: (c.segments ?? 0).toLocaleString() },
    { k: "weather", v: (c.conditions ?? 0).toLocaleString() },
  ]);
  return d;
}
async function loadKalman() {
  try {
    const s = await getJSON(`${KALMAN}/stats`);
    cards(document.getElementById("kalman"), [
      { k: "tracked", v: s.tracked ?? 0 },
      { k: "pos err (med)", v: `${(s.posInnovMedianM ?? 0).toFixed(1)}m` },
      { k: "speed err (mean)", v: `${(s.speedInnovMeanMps ?? 0).toFixed(2)} m/s` },
      { k: "vs baseline", v: "5.72 m/s" },
    ]);
  } catch {
    document.getElementById("kalman").innerHTML = '<div class="empty">Kalman service (:8092) not reachable</div>';
  }
}
async function loadAccuracy(d) {
  const b = (d.buckets || []).filter((x) => x.n > 0);
  if (!b.length) { charts.acc?.destroy(); return; }
  draw("acc", {
    type: "bar",
    data: { labels: b.map((x) => x.leadLabel), datasets: [{ label: "MAE (s)", data: b.map((x) => x.maeSec), backgroundColor: ACCENT, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes("seconds") },
  });
}

// Dedicated feed-vs-model comparison: same lead-time buckets, both sources
// graded identically, rendered side by side (MAE) plus a bias chart (which
// way each source tends to be wrong — late = positive, early = negative).
async function loadHeadToHead() {
  const ALL_LABELS = ["0-1 min", "1-2 min", "2-5 min", "5-10 min", "10+ min"];
  let feed, model;
  try {
    [feed, model] = await Promise.all([
      getJSON(`${BACKEND}/api/prediction-accuracy?source=gtfs-rt`),
      getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v1`),
    ]);
  } catch {
    document.getElementById("h2h-cards").innerHTML = '<div class="empty">backend not reachable</div>';
    return;
  }
  const byLabel = (buckets) => Object.fromEntries((buckets || []).map((b) => [b.leadLabel, b]));
  const fb = byLabel(feed.buckets), mb = byLabel(model.buckets);
  const modelN = model.buckets?.reduce((s, b) => s + b.n, 0) ?? 0;
  const feedN = feed.buckets?.reduce((s, b) => s + b.n, 0) ?? 0;

  cards(document.getElementById("h2h-cards"), [
    { k: "feed graded predictions", v: feedN.toLocaleString() },
    { k: "model graded predictions", v: modelN.toLocaleString() },
    { k: "model status", v: modelN > 0 ? "collecting" : "no data yet" },
  ]);

  if (modelN === 0) {
    charts.h2h?.destroy(); charts["h2h-bias"]?.destroy();
    document.getElementById("h2h").parentElement.innerHTML = '<div class="empty">model-v1 predictions not graded yet — the model needs to log predictions and then trains need to actually arrive (a few minutes)</div>';
    return;
  }

  const labels = ALL_LABELS.filter((l) => (fb[l]?.n ?? 0) > 0 || (mb[l]?.n ?? 0) > 0);
  draw("h2h", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "feed (gtfs-rt) MAE", data: labels.map((l) => fb[l]?.maeSec ?? null), backgroundColor: ACCENT, borderRadius: 4 },
        { label: "model (model-v1) MAE", data: labels.map((l) => mb[l]?.maeSec ?? null), backgroundColor: "#f0902f", borderRadius: 4 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: axes("MAE (s)") },
  });
  draw("h2h-bias", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "feed bias (+ = late)", data: labels.map((l) => fb[l]?.biasSec ?? null), backgroundColor: ACCENT, borderRadius: 4 },
        { label: "model bias (+ = late)", data: labels.map((l) => mb[l]?.biasSec ?? null), backgroundColor: "#f0902f", borderRadius: 4 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: axes("bias (s)") },
  });
}
async function loadTrend() {
  // feed vs model overall MAE over time (n-weighted average across lead buckets)
  const [feed, model] = await Promise.all([
    getJSON(`${BACKEND}/api/accuracy-trend?source=gtfs-rt`),
    getJSON(`${BACKEND}/api/accuracy-trend?source=model-v1`),
  ]);
  const overall = (pts) => {
    const byTs = {};
    for (const p of pts || []) { (byTs[p.ts] ??= { s: 0, n: 0 }); byTs[p.ts].s += p.maeSec * p.n; byTs[p.ts].n += p.n; }
    return byTs;
  };
  const f = overall(feed.points), m = overall(model.points);
  const times = [...new Set([...Object.keys(f), ...Object.keys(m)].map(Number))].sort((a, b) => a - b);
  if (!times.length) { charts.trend?.destroy(); return; }
  const line = (map) => times.map((t) => (map[t] && map[t].n ? Math.round(map[t].s / map[t].n) : null));
  draw("trend", {
    type: "line",
    data: {
      labels: times.map((t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      datasets: [
        { label: "feed MAE", data: line(f), borderColor: ACCENT, spanGaps: true, tension: 0.3, pointRadius: 2 },
        { label: "model MAE", data: line(m), borderColor: "#f0902f", spanGaps: true, tension: 0.3, pointRadius: 2 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: axes("MAE (s)") },
  });
}
async function loadImportance() {
  try {
    const d = await getJSON(`${ANALYTICS}/feature-importance`);
    const imp = d.importance || {};
    const entries = Object.entries(imp).sort((a, b) => b[1] - a[1]);
    if (!entries.length) throw new Error("empty");
    draw("importance", {
      type: "bar",
      data: { labels: entries.map((e) => e[0]), datasets: [{ label: "gain", data: entries.map((e) => e[1]), backgroundColor: "#7ed957", borderRadius: 4 }] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes("") },
    });
  } catch {
    charts.importance?.destroy();
  }
}
async function loadFeature() {
  const f = document.getElementById("feature").value;
  const d = await getJSON(`${BACKEND}/api/feature-stats?feature=${encodeURIComponent(f)}`);
  const s = (d.stats || []).slice(0, 24);
  if (!s.length) { charts.feat?.destroy(); return; }
  draw("feat", {
    type: "bar",
    data: { labels: s.map((x) => x.value), datasets: [{ label: "avg travel (s)", data: s.map((x) => x.avgTravel), backgroundColor: ACCENT, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes("avg travel (s)") },
  });
}

// ---- recent arrivals scorecard: estimated ETA vs ATA, case by case ----
async function loadRecentArrivals() {
  let d;
  try { d = await getJSON(`${BACKEND}/api/recent-arrivals`); }
  catch { document.getElementById("recent-table").innerHTML = '<div class="empty">backend not reachable</div>'; return; }
  const rows = d.rows || [];
  if (!rows.length) { document.getElementById("recent-table").innerHTML = '<div class="empty">no graded arrivals yet</div>'; return; }
  const fmtT = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const cell = (s) => (s ? `${s.errSec >= 0 ? "+" : ""}${s.errSec}s` : "–");
  const closer = (r) => {
    if (!r.feed || !r.model) return "";
    const winner = Math.abs(r.feed.errSec) <= Math.abs(r.model.errSec) ? "feed" : "model";
    const col = winner === "feed" ? "#3FD8FF" : "#f0902f";
    return `<span style="color:${col}">${winner}</span>`;
  };
  document.getElementById("recent-table").innerHTML =
    `<table><thead><tr><th>ATA</th><th>route</th><th>station</th><th>feed Δ</th><th>model Δ</th><th>closer</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td>${fmtT(r.actualArrival)}</td>
      <td><span class="route-badge" style="background:#1f2937">${r.route}</span></td>
      <td>${r.station}</td>
      <td style="color:${r.feed ? "#3FD8FF" : "var(--muted)"}">${cell(r.feed)}</td>
      <td style="color:${r.model ? "#f0902f" : "var(--muted)"}">${cell(r.model)}</td>
      <td>${closer(r)}</td></tr>`).join("") +
    `</tbody></table>`;
}

// ---- per-train ----
async function loadTrip() {
  const id = document.getElementById("tripid").value.trim();
  if (!id) return;
  const d = await getJSON(`${BACKEND}/api/trip-history?id=${encodeURIComponent(id)}`);
  const segs = d.segments || [];
  document.getElementById("trip-meta").textContent =
    `${segs.length} segments · ${(d.predictions || []).length} prediction rows · ${(d.actuals || []).length} actual arrivals`;
  if (segs.length) {
    draw("trip-seg", {
      type: "bar",
      data: { labels: segs.map((s) => `${s.from_stop}→${s.to_stop}`), datasets: [{ label: "travel (s)", data: segs.map((s) => s.travel_sec), backgroundColor: ACCENT, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes("seconds") },
    });
    document.getElementById("trip-table").innerHTML =
      `<table><thead><tr><th>from→to</th><th>travel</th><th>weather</th><th>hr</th></tr></thead><tbody>` +
      segs.map((s) => `<tr><td>${s.from_stop}→${s.to_stop}</td><td>${s.travel_sec}s</td><td>${s.weather_score ?? "–"}</td><td>${s.hour}</td></tr>`).join("") +
      `</tbody></table>`;
  } else {
    document.getElementById("trip-table").innerHTML = '<div class="empty">no segments recorded for that trip id yet</div>';
    charts["trip-seg"]?.destroy();
  }
}

// ---- mode switch + boot ----
function setMode(m) {
  document.getElementById("mode-system").classList.toggle("on", m === "system");
  document.getElementById("mode-train").classList.toggle("on", m === "train");
  document.getElementById("view-system").classList.toggle("hidden", m !== "system");
  document.getElementById("view-train").classList.toggle("hidden", m !== "train");
}
document.getElementById("mode-system").onclick = () => setMode("system");
document.getElementById("mode-train").onclick = () => setMode("train");
document.getElementById("feature").onchange = loadFeature;
document.getElementById("loadtrip").onclick = loadTrip;

async function refresh() {
  try {
    const d = await loadCounts();
    await Promise.all([loadKalman(), loadAccuracy(d), loadHeadToHead(), loadRecentArrivals(), loadTrend(), loadImportance(), loadFeature()]);
    document.getElementById("status").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("status").textContent = "error: " + e.message;
  }
}
refresh();
setInterval(refresh, 15000);
