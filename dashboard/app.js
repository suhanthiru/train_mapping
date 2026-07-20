// Analytics dashboard (roadmap Phase 4). Reads the live services and renders
// Chart.js panels. Decoupled from the 3D map — charts, not GPU.
// Two deployment modes, distinguished by port (the dashboard's own dev/direct
// port is always 4174 — see dashboard/serve.mjs):
//  - direct-port (local dev, or a VPS with all ports opened, no TLS): each
//    service is reached on the page's own host at its own explicit port.
//  - behind a TLS proxy (Caddy/nginx on 80/443, no port in the URL): explicit
//    cross-port fetches would be mixed-content-blocked, so instead we use
//    same-origin path prefixes that infra/Caddyfile + infra/nginx.conf proxy
//    through to each backend (see those files for the matching routes).
// Ports/colors come from window.TT_CONFIG (dashboard/config.js — GENERATED
// from shared/config.ts, the single source; regenerate: npm run gen:config).
const CFG = window.TT_CONFIG ?? { ports: { train_3d_map: 8080, kalmanRs: 8092, analyticsPy: 8091, dashboard: 4174 },
                                  colors: { accent: "#3FD8FF", axis: "#8b98a5", grid: "#1f2937" } };
const H = location.hostname || "localhost";
const PROTO = location.protocol === "file:" ? "http:" : location.protocol;
const directPort = location.port === String(CFG.ports.dashboard) || location.protocol === "file:";
const BACKEND = directPort ? `${PROTO}//${H}:${CFG.ports.train_3d_map}` : `${location.origin}/api-backend`;
const KALMAN = directPort ? `${PROTO}//${H}:${CFG.ports.kalmanRs}` : `${location.origin}/api-kalman`;
const ANALYTICS = directPort ? `${PROTO}//${H}:${CFG.ports.analyticsPy}` : `${location.origin}/api-analytics`;

const AX = CFG.colors.axis, GRID = CFG.colors.grid, ACCENT = CFG.colors.accent;
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

// "127" -> "2 minutes 7 seconds", "42" -> "42 seconds" — used by Simple mode
// so every number reads as a duration a non-technical reader can picture.
function fmtDuration(sec) {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60), r = s % 60;
  return r
    ? `${m} minute${m === 1 ? "" : "s"} ${r} second${r === 1 ? "" : "s"}`
    : `${m} minute${m === 1 ? "" : "s"}`;
}
const isSimple = () => document.body.classList.contains("simple");

// ---- Simple mode: one plain-English summary panel, computed from the same
// endpoints the technical panels already use, just spoken as sentences
// instead of charts. "MAE" becomes "beats/behind the MTA by N minutes". ----
async function loadPlainSummary() {
  const el = document.getElementById("plain-content");
  try {
    const [feed, v1, v2, health, recent] = await Promise.all([
      getJSON(`${BACKEND}/api/prediction-accuracy?source=gtfs-rt`),
      getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v1`),
      getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v2`).catch(() => ({ buckets: [] })),
      getJSON(`${BACKEND}/api/system-health`).catch(() => null),
      getJSON(`${BACKEND}/api/recent-arrivals`).catch(() => ({ rows: [] })),
    ]);
    // n-weighted average MAE/bias across graded lead-time buckets — same math
    // as loadTrend's "overall" reduction, just named for a lay reader here.
    const overall = (d) => {
      const b = (d.buckets || []).filter((x) => x.n > 0);
      const n = b.reduce((s, x) => s + x.n, 0);
      if (!n) return null;
      return { n, mae: b.reduce((s, x) => s + x.maeSec * x.n, 0) / n };
    };
    const F = overall(feed), V1 = overall(v1), V2 = overall(v2);
    const useV2 = V2 && V2.n >= 20; // enough graded predictions to be more than noise
    const ours = useV2 ? V2 : V1;
    const oursLabel = useV2 ? "our newest prediction system" : "our prediction system";

    const cards = [];

    // 1. Headline: do we beat the MTA's own estimate, and by how much?
    if (F && ours) {
      const diff = F.mae - ours.mae; // positive = we're more accurate (lower avg error)
      if (Math.abs(diff) < 2) {
        cards.push(`<div class="plain-card"><span class="plain-emoji">🤝</span>${oursLabel} is about as accurate as the MTA's own estimate right now — both are typically off by around <b>${fmtDuration(ours.mae)}</b>.</div>`);
      } else if (diff > 0) {
        cards.push(`<div class="plain-card plain-good"><span class="plain-emoji">🎉</span>${oursLabel} beats the MTA's official estimate by <b>${fmtDuration(diff)}</b> on average. The MTA is typically off by ${fmtDuration(F.mae)}; ours is off by ${fmtDuration(ours.mae)}.</div>`);
      } else {
        cards.push(`<div class="plain-card plain-bad"><span class="plain-emoji">📉</span>The MTA's own estimate is currently more accurate than ${oursLabel}, by <b>${fmtDuration(-diff)}</b>. We're off by ${fmtDuration(ours.mae)} on average; the MTA is off by ${fmtDuration(F.mae)}.</div>`);
      }
    } else {
      cards.push(`<div class="plain-card"><span class="plain-emoji">⏳</span>Still collecting enough real arrivals to compare our predictions to the MTA's.</div>`);
    }

    // 2. The v1-vs-v2 story, only once v2 has enough real data to say something.
    if (V1 && useV2 && V1.mae - V2.mae > 2) {
      cards.push(`<div class="plain-card"><span class="plain-emoji">🛠️</span>We recently fixed a bug in our prediction system. The <b>new version</b> is <b>${fmtDuration(V1.mae - V2.mae)}</b> more accurate on average than the old one.</div>`);
    }

    // 3. Is the whole thing even running right now?
    if (health) {
      const age = health.feedAgeSec;
      if (age != null && age < 90) {
        cards.push(`<div class="plain-card"><span class="plain-emoji">🟢</span>Everything is running live — we got fresh train positions <b>${age} second${age === 1 ? "" : "s"} ago</b>, tracking <b>${health.trains}</b> trains right now.</div>`);
      } else {
        cards.push(`<div class="plain-card plain-bad"><span class="plain-emoji">🔴</span>We haven't heard from the live train feed in a while — something may be down.</div>`);
      }
    }

    // 4. A concrete scoreboard over real, recent arrivals — the "receipts".
    const graded = (recent.rows || []).filter((r) => r.feed && r.model);
    if (graded.length) {
      const ourWins = graded.filter((r) => Math.abs(r.model.errSec) <= Math.abs(r.feed.errSec)).length;
      cards.push(`<div class="plain-card"><span class="plain-emoji">🏆</span>Looking at the last <b>${graded.length}</b> trains that actually arrived, our prediction was closer to the truth <b>${ourWins} out of ${graded.length}</b> times (the MTA won the rest).</div>`);
    }

    el.innerHTML = cards.join("");
  } catch {
    el.innerHTML = '<div class="empty">couldn\'t load a plain summary right now — the backend may be down</div>';
  }
}

// ---- system panels ----
async function loadSysHealth() {
  const el = document.getElementById("syshealth");
  try {
    const [h, py] = await Promise.all([
      getJSON(`${BACKEND}/api/system-health`),
      getJSON(`${ANALYTICS}/health`).catch(() => null),
    ]);
    const age = h.feedAgeSec;
    const feedCol = age == null ? "var(--muted)" : age < 90 ? "#7ed957" : age < 300 ? "#f0c040" : "#e53950";
    const w = h.writeRates || {};
    const items = [
      { k: "feed age", v: `<span style="color:${feedCol}">${age == null ? "—" : age + "s"}</span>` },
      { k: "trains / buses", v: `${h.trains} / ${h.buses}` },
      { k: "preds/hr", v: (w.predictionsPerHour ?? 0).toLocaleString() },
      { k: "actuals/hr", v: (w.actualsPerHour ?? 0).toLocaleString() },
      { k: "vehicle log/hr", v: (w.vehicleLogPerHour ?? 0).toLocaleString() },
      { k: "model v1 / v2", v: py ? `${py.model_loaded ? "✓" : "✗"} / ${py.model_v2_loaded ? "✓" : "✗"}` : "py down" },
      { k: "ridership keys", v: py?.ridership ? (py.ridership.profile_keys ?? 0).toLocaleString() : "—" },
    ];
    el.innerHTML = items
      .map((i) => `<div class="card"><div class="k">${i.k}</div><div class="v">${i.v}</div></div>`)
      .join("");
  } catch {
    el.innerHTML = '<div class="empty">backend not reachable — the pipeline is DOWN (this panel existing is the point)</div>';
  }
}

// ---- uptime: hourly throughput over the last 24h — feed rows/hr is the
// truest "was the pipeline alive" signal (model-v1's count is inflated by the
// known re-logging bug, so it's not used for the uptime read). ----
async function loadThroughput() {
  let d;
  try { d = await getJSON(`${BACKEND}/api/throughput?hours=24`); }
  catch { document.getElementById("throughput-summary").textContent = "backend not reachable"; return; }
  const hours = d.hours || [];
  if (!hours.length) { charts.throughput?.destroy(); return; }
  const fmtH = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit" });
  draw("throughput", {
    type: "bar",
    data: {
      labels: hours.map((h) => fmtH(h.hourStart)),
      datasets: [{ label: "feed rows/hr", data: hours.map((h) => h.feed), backgroundColor: ACCENT, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: axes("feed rows"),
    },
  });
  const liveHours = hours.filter((h) => h.feed > 0).length;
  const gapHours = hours.length - liveHours;
  const pct = Math.round(100 * liveHours / hours.length);
  const col = gapHours === 0 ? "#7ed957" : gapHours <= 4 ? "#f0c040" : "#e53950";
  document.getElementById("throughput-summary").innerHTML =
    `<span style="color:${col}">${liveHours}/${hours.length} hours collecting (${pct}%)</span>` +
    (gapHours ? ` · ${gapHours}h of gaps — pipeline wasn't running or the feed was unreachable` : " · fully up this window");
}

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
  let feed, model, model2;
  try {
    [feed, model, model2] = await Promise.all([
      getJSON(`${BACKEND}/api/prediction-accuracy?source=gtfs-rt`),
      getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v1`),
      getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v2`).catch(() => ({ buckets: [] })),
    ]);
  } catch {
    document.getElementById("h2h-cards").innerHTML = '<div class="empty">backend not reachable</div>';
    return;
  }
  const byLabel = (buckets) => Object.fromEntries((buckets || []).map((b) => [b.leadLabel, b]));
  const fb = byLabel(feed.buckets), mb = byLabel(model.buckets), m2b = byLabel(model2.buckets);
  const sum = (d) => d.buckets?.reduce((s, b) => s + b.n, 0) ?? 0;
  const feedN = sum(feed), modelN = sum(model), model2N = sum(model2);

  cards(document.getElementById("h2h-cards"), [
    { k: "feed graded", v: feedN.toLocaleString() },
    { k: "model-v1 graded", v: modelN.toLocaleString() },
    { k: "model-v2 graded", v: model2N > 0 ? model2N.toLocaleString() : "collecting…" },
  ]);

  if (modelN === 0 && model2N === 0) {
    charts.h2h?.destroy(); charts["h2h-bias"]?.destroy();
    document.getElementById("h2h").parentElement.innerHTML = '<div class="empty">model predictions not graded yet — the models need to log predictions and then trains need to actually arrive (a few minutes)</div>';
    return;
  }

  const V2 = "#7ed957"; // green: the late-bias fix — watch its 0-2min bias vs v1's
  const labels = ALL_LABELS.filter((l) => (fb[l]?.n ?? 0) > 0 || (mb[l]?.n ?? 0) > 0 || (m2b[l]?.n ?? 0) > 0);
  const ds = (map, key) => labels.map((l) => map[l]?.[key] ?? null);
  const maeSets = [
    { label: "feed (gtfs-rt) MAE", data: ds(fb, "maeSec"), backgroundColor: ACCENT, borderRadius: 4 },
    { label: "model-v1 MAE", data: ds(mb, "maeSec"), backgroundColor: "#f0902f", borderRadius: 4 },
  ];
  const biasSets = [
    { label: "feed bias (+ = late)", data: ds(fb, "biasSec"), backgroundColor: ACCENT, borderRadius: 4 },
    { label: "v1 bias (+ = late)", data: ds(mb, "biasSec"), backgroundColor: "#f0902f", borderRadius: 4 },
  ];
  if (model2N > 0) {
    maeSets.push({ label: "model-v2 MAE (frac_hop)", data: ds(m2b, "maeSec"), backgroundColor: V2, borderRadius: 4 });
    biasSets.push({ label: "v2 bias (+ = late)", data: ds(m2b, "biasSec"), backgroundColor: V2, borderRadius: 4 });
  }
  draw("h2h", {
    type: "bar",
    data: { labels, datasets: maeSets },
    options: { responsive: true, maintainAspectRatio: false, scales: axes("MAE (s)") },
  });
  draw("h2h-bias", {
    type: "bar",
    data: { labels, datasets: biasSets },
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
  // model status line (retrain loop visibility)
  try {
    const h = await getJSON(`${ANALYTICS}/health`);
    const when = h.last_trained ? new Date(h.last_trained * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "startup";
    const v2 = h.model_v2_loaded ? ` · v2: ${(h.v2_n_train ?? 0).toLocaleString()} mid-hop samples, MAE ${h.v2_mae ?? "—"}s` : " · v2: not trained yet";
    document.getElementById("model-status").textContent =
      `v1: ${(h.n_train ?? 0).toLocaleString()} segments, MAE ${h.mae ?? "—"}s${v2} · last retrained ${when}`;
  } catch { /* leave default */ }
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

// ---- graph GNN experiment: Baseline / Graph A / Graph B / Graph C ----
// Reads the frozen offline result (analytics-py/graph_experiment.py). Graph A
// (FOLLOWS-only) is the winner; B/C add nothing — the panel shows that plainly.
async function loadGraphExperiment() {
  const panel = document.getElementById("graph-panel");
  let d;
  try { d = await getJSON(`${BACKEND}/api/graph-experiment`); }
  catch { return; }
  const cardsEl = document.getElementById("graph-cards");
  const verdictEl = document.getElementById("graph-verdict");
  const titleEl = document.getElementById("graph-title");
  const subEl = document.getElementById("graph-sub");
  const simple = isSimple();
  if (!d || d.available === false || !d.short_lead_mae) {
    charts["graph-mae"]?.destroy();
    cardsEl.innerHTML = '<div class="empty">no experiment yet — run <span class="mono">python analytics-py/graph_experiment.py</span></div>';
    verdictEl.textContent = "";
    return;
  }
  const m = d.short_lead_mae; // {baseline, graph_a, graph_b, graph_c}
  const order = ["baseline", "graph_a", "graph_b", "graph_c"];
  const nice = { baseline: "Baseline (v2)", graph_a: "Graph A · FOLLOWS", graph_b: "Graph B · +SHARES", graph_c: "Graph C · network" };
  const base = m.baseline;
  const best = order.slice(1).reduce((b, k) => (m[k] < m[b] ? k : b), "graph_a");

  if (titleEl) titleEl.textContent = simple ? "Can nearby trains improve our guess?" : "Graph GNN experiment — cross-train residual correction";
  if (subEl) subEl.textContent = simple
    ? "we tested whether looking at nearby trains helps our newest prediction. Lower bar = more accurate."
    : "offline A/B/C test: does a GNN using nearby trains (FOLLOWS = same line ahead, SHARES_TRACK = cross-route junction) correct model-v2's error? Each bar = short-lead (0–2 min) MAE; lower is better.";

  cards(cardsEl, order.map((k) => ({
    k: simple ? nice[k].split(" · ")[0] : nice[k],
    v: simple ? fmtDuration(m[k]) : `${m[k]}s`,
  })));

  const colorFor = (k) => k === "baseline" ? "#8b98a5" : k === best ? "#7ed957" : ACCENT;
  draw("graph-mae", {
    type: "bar",
    data: {
      labels: order.map((k) => nice[k]),
      datasets: [{ label: "short-lead MAE (s)", data: order.map((k) => m[k]), backgroundColor: order.map(colorFor), borderRadius: 4 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: axes("MAE (s)") },
  });

  // verdict line — honest: A beats baseline, B/C add nothing
  const impr = Math.round((base - m.graph_a) * 10) / 10;
  const pct = Math.round(100 * (base - m.graph_a) / base);
  const v = d.verdicts || {};
  if (simple) {
    verdictEl.innerHTML =
      `<b style="color:#7ed957">Looking at the train ahead on the same line makes our guess about ${fmtDuration(impr)} more accurate</b> ` +
      `(~${pct}% better). Adding cross-line junctions or the whole network on top of that didn't help — the train directly ahead is what matters.`;
  } else {
    const tag = (ok) => ok === "PASS" ? '<span style="color:#7ed957">PASS</span>' : '<span style="color:var(--muted)">no gain</span>';
    verdictEl.innerHTML =
      `<b>Graph A</b> (FOLLOWS-only) beats baseline by <b>${impr}s</b> (~${pct}%): ${tag(v.graph_a_vs_baseline)}. ` +
      `<b>Graph B</b> vs A: ${tag(v.graph_b_vs_a)}. <b>Graph C</b> vs B: ${tag(v.graph_c_vs_b)}. ` +
      `→ the same-line train ahead carries the signal; cross-route + whole-network add nothing at this data volume. ` +
      `<span style="color:var(--muted)">n=${(d.n_test_nodes ?? 0).toLocaleString()} test nodes${v.underpowered ? " · UNDERPOWERED" : ""} · directional (4–5 day data)</span>`;
  }
}

// ---- recent arrivals scorecard: estimated ETA vs ATA, case by case ----
async function loadRecentArrivals() {
  let d;
  try { d = await getJSON(`${BACKEND}/api/recent-arrivals`); }
  catch { document.getElementById("recent-table").innerHTML = '<div class="empty">backend not reachable</div>'; return; }
  const rows = d.rows || [];
  if (!rows.length) { document.getElementById("recent-table").innerHTML = '<div class="empty">no graded arrivals yet</div>'; return; }
  const simple = isSimple();
  const titleEl = document.getElementById("recent-title"), subEl = document.getElementById("recent-sub");
  if (titleEl) titleEl.textContent = simple ? "Recent arrivals — who guessed better?" : "Recent arrivals — estimated ETA vs. actual (ATA)";
  if (subEl) subEl.textContent = simple
    ? "the last 30 trains that actually arrived, and how far off each guess was"
    : "the last 30 stops trains actually reached · each source's final prediction vs. what happened (Δ = predicted − actual, + is late)";
  const fmtT = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const cell = (s) => {
    if (!s) return "–";
    if (!simple) return `${s.errSec >= 0 ? "+" : ""}${s.errSec}s`;
    if (Math.abs(s.errSec) < 5) return "on time";
    return `${fmtDuration(s.errSec)} ${s.errSec >= 0 ? "late" : "early"}`;
  };
  const closer = (r) => {
    if (!r.feed || !r.model) return "";
    const winner = Math.abs(r.feed.errSec) <= Math.abs(r.model.errSec) ? "feed" : "model";
    const col = winner === "feed" ? "#3FD8FF" : "#f0902f";
    const label = simple ? (winner === "feed" ? "MTA" : "Us") : winner;
    return `<span style="color:${col}">${label}</span>`;
  };
  const heads = simple
    ? ["arrived at", "route", "station", "MTA's guess", "our guess", "closer"]
    : ["ATA", "route", "station", "feed Δ", "model Δ", "closer"];
  document.getElementById("recent-table").innerHTML =
    `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
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

// Simple mode: one button reframes the whole page for a non-technical reader
// — swaps in a plain-English summary, hides every chart/jargon panel (marked
// .jargon), and forces out of the technical Per-train view.
function setPlainMode(on) {
  document.body.classList.toggle("simple", on);
  document.getElementById("mode-plain").classList.toggle("on", on);
  if (on) setMode("system");
  loadPlainSummary();
  loadRecentArrivals(); // headers/cells reword immediately, don't wait for the next tick
  loadGraphExperiment();
}
document.getElementById("mode-plain").onclick = () => setPlainMode(!isSimple());

// ---- P4: anomaly panel + per-route ops row ----
// Data: BACKEND /api/anomalies {current, recent} (schedule-deviation, cause,
// alert cross-ref) + /api/prediction-accuracy (model-v2) for the fused row.
function routeBadge(r) {
  return `<span style="display:inline-block;min-width:20px;text-align:center;background:${ACCENT};color:#0a0e14;border-radius:10px;padding:1px 7px;font-weight:600;">${r ?? "?"}</span>`;
}

async function loadAnomalies() {
  const d = await getJSON(`${BACKEND}/api/anomalies`).catch(() => ({ current: [], recent: [] }));
  const cur = d.current ?? [];
  const recent = d.recent ?? [];

  const cards = document.getElementById("anomaly-cards");
  const routesNow = [...new Set(cur.map((a) => a.route_id))];
  cards.innerHTML = `
    <div class="card"><div class="k">active now</div><div class="v" style="color:${cur.length ? "#f0902f" : "#7ed957"}">${cur.length}</div></div>
    <div class="card"><div class="k">routes affected</div><div class="v">${routesNow.length ? routesNow.join(" ") : "—"}</div></div>
    <div class="card"><div class="k">episodes (6h)</div><div class="v">${recent.length}</div></div>
    <div class="card"><div class="k">with known alert</div><div class="v">${cur.filter((a) => a.alert_active).length}/${cur.length}</div></div>`;

  const tbl = document.getElementById("anomaly-table");
  if (!cur.length) {
    tbl.innerHTML = `<div class="empty">no trains currently anomalous — checking every 30s${recent.length ? ` · ${recent.length} episode(s) in the last 6h below the fold` : ""}</div>`;
  } else {
    const rows = cur
      .sort((a, b) => (b.deviation_sec ?? 0) - (a.deviation_sec ?? 0))
      .slice(0, 12)
      .map((a) => `<tr>
        <td><a href="${BACKEND}/?trip=${encodeURIComponent(a.id)}" target="_blank" title="show on the live map" style="text-decoration:none">${routeBadge(a.route_id)}</a></td>
        <td>${a.from_stop} → ${a.to_stop}</td>
        <td>${fmtDuration(a.observed_sec)} vs ${a.scheduled_sec != null ? fmtDuration(a.scheduled_sec) : "?"} sched</td>
        <td style="color:#f0902f">+${a.deviation_sec != null ? fmtDuration(a.deviation_sec) : "?"}</td>
        <td>${a.alert_active ? "🔔 alert active" : "no alert"}</td>
        <td>${a.likely_cause?.cause ?? "—"}</td>
      </tr>`).join("");
    tbl.innerHTML = `<table><tr><th>route</th><th>hop</th><th>observed vs scheduled</th><th>over</th><th>alert?</th><th>likely cause</th></tr>${rows}</table>`;
  }
  return { cur, recent };
}

async function loadOpsRow(anom) {
  const el = document.getElementById("ops-table");
  const v2 = await getJSON(`${BACKEND}/api/prediction-accuracy?source=model-v2`).catch(() => ({ buckets: [] }));
  const v2mae = v2.buckets?.length ? Math.round(v2.buckets.reduce((s, b) => s + (b.mae_sec ?? 0), 0) / v2.buckets.length) : null;

  const byRoute = new Map();
  for (const a of anom.cur) {
    const r = byRoute.get(a.route_id) ?? { active: 0, recent: 0, alert: false, cause: null };
    r.active++; r.alert = r.alert || a.alert_active; r.cause = r.cause ?? a.likely_cause?.cause;
    byRoute.set(a.route_id, r);
  }
  for (const a of anom.recent) {
    const r = byRoute.get(a.route_id) ?? { active: 0, recent: 0, alert: false, cause: null };
    r.recent++; r.cause = r.cause ?? a.cause;
    byRoute.set(a.route_id, r);
  }
  if (!byRoute.size) {
    el.innerHTML = `<div class="empty">all routes nominal · model-v2 avg MAE ${v2mae != null ? fmtDuration(v2mae) : "n/a"}</div>`;
    return;
  }
  const rows = [...byRoute.entries()]
    .sort((a, b) => b[1].active - a[1].active || b[1].recent - a[1].recent)
    .map(([route, r]) => `<tr>
      <td>${routeBadge(route)}</td>
      <td style="color:${r.active ? "#f0902f" : "#7ed957"}">${r.active} active</td>
      <td>${r.recent} episode(s) 6h</td>
      <td>${r.alert ? "🔔 alert" : "—"}</td>
      <td>${r.cause ?? "—"}</td>
      <td>${v2mae != null ? "v2 MAE " + fmtDuration(v2mae) : ""}</td>
    </tr>`).join("");
  el.innerHTML = `<table><tr><th>route</th><th>now</th><th>history</th><th>alert</th><th>dominant cause</th><th>model</th></tr>${rows}</table>`;
}

async function refresh() {
  try {
    const d = await loadCounts();
    const anom = await loadAnomalies();
    await Promise.all([loadPlainSummary(), loadSysHealth(), loadThroughput(), loadKalman(), loadAccuracy(d), loadHeadToHead(), loadGraphExperiment(), loadRecentArrivals(), loadTrend(), loadImportance(), loadFeature(), loadOpsRow(anom)]);
    document.getElementById("status").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("status").textContent = "error: " + e.message;
  }
}
refresh();
setInterval(refresh, 15000);
