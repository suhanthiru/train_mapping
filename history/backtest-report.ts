// DuckDB-powered backtest deep-report: grade EVERY logged prediction source
// (gtfs-rt feed, model-v1 full-hop chaining, model-v2 frac_hop remaining-time)
// against ground truth, over the full prediction history — the offline analysis
// the live /api/prediction-accuracy endpoint can't afford at millions of rows.
// DuckDB attaches the SQLite ledger READ-ONLY (same pattern as export.ts), so
// this never contends with the live backend writing to ledger.db.
//
// This is the verdict tool for the late-bias fix: watch model-v2's bias in the
// 0-2 min buckets vs model-v1's (+ is late; v1's known failure is ~85-130s).
//
// Run: npm run report:backtest

import duckdb from "duckdb";
import { join } from "node:path";

const LEDGER = join(process.cwd(), "data", "ledger.db").replace(/\\/g, "/");

const db = new duckdb.Database(":memory:");
const run = (sql: string): Promise<any[]> =>
  new Promise((res, rej) => db.all(sql, (e: Error | null, r: any[]) => (e ? rej(e) : res(r))));

// Same grading rules as ledger.accuracyByLeadTime(): only predictions made
// BEFORE the arrival, within a 30-min lead window; bucket by TRUE lead time.
const GRADED = `
  SELECT p.source,
         p.route_id,
         (a.actual_arrival - p.observed_at) AS lead,
         (p.pred_arrival - a.actual_arrival) AS err
  FROM led.predictions p
  JOIN led.actuals a ON a.trip_id = p.trip_id AND a.stop_id = p.stop_id
  WHERE p.observed_at <= a.actual_arrival
    AND (a.actual_arrival - p.observed_at) BETWEEN 0 AND 1800
`;

const BUCKET = `
  CASE WHEN lead < 60 THEN '0-1 min' WHEN lead < 120 THEN '1-2 min'
       WHEN lead < 300 THEN '2-5 min' WHEN lead < 600 THEN '5-10 min'
       ELSE '10+ min' END
`;

function table(rows: any[], cols: string[]): void {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
}

async function main() {
  await run("INSTALL sqlite; LOAD sqlite;");
  await run(`ATTACH '${LEDGER}' AS led (TYPE SQLITE, READ_ONLY)`);

  console.log("\n=== Graded predictions per source (full history) ===");
  const counts = await run(
    `SELECT source, count(*) AS graded FROM (${GRADED}) GROUP BY source ORDER BY source`
  );
  table(counts, ["source", "graded"]);

  console.log("\n=== MAE + bias by lead time (bias: + = late; v1's known failure is 85-130s late at short leads) ===");
  const byLead = await run(
    `SELECT source, ${BUCKET} AS lead_bucket, count(*) AS n,
            CAST(avg(abs(err)) AS INTEGER) AS mae_sec,
            CAST(avg(err) AS INTEGER) AS bias_sec,
            CAST(median(abs(err)) AS INTEGER) AS median_ae_sec
     FROM (${GRADED})
     GROUP BY source, lead_bucket
     ORDER BY source, min(lead)`
  );
  table(byLead, ["source", "lead_bucket", "n", "mae_sec", "bias_sec", "median_ae_sec"]);

  console.log("\n=== Worst routes per source (short-lead bias, <2 min out, n>=50) ===");
  const byRoute = await run(
    `SELECT source, route_id, count(*) AS n,
            CAST(avg(err) AS INTEGER) AS bias_sec,
            CAST(avg(abs(err)) AS INTEGER) AS mae_sec
     FROM (${GRADED}) WHERE lead < 120
     GROUP BY source, route_id HAVING count(*) >= 50
     ORDER BY source, abs(avg(err)) DESC`
  );
  // top 5 per source is plenty for a terminal report
  const bySource = new Map<string, any[]>();
  for (const r of byRoute) {
    const arr = bySource.get(r.source) ?? [];
    if (arr.length < 5) { arr.push(r); bySource.set(r.source, arr); }
  }
  table([...bySource.values()].flat(), ["source", "route_id", "n", "bias_sec", "mae_sec"]);

  console.log("\n=== v1 vs v2 head-to-head (same trips+stops+minute only — apples to apples) ===");
  // Only compare where BOTH models predicted the same (trip, stop) around the
  // same observation minute, so composition differences can't fake a result.
  const h2h = await run(
    `WITH g AS (SELECT p.source, p.trip_id, p.stop_id,
                       CAST(p.observed_at / 60 AS INTEGER) AS obs_min,
                       (a.actual_arrival - p.observed_at) AS lead,
                       abs(p.pred_arrival - a.actual_arrival) AS ae,
                       (p.pred_arrival - a.actual_arrival) AS err
                FROM led.predictions p
                JOIN led.actuals a ON a.trip_id = p.trip_id AND a.stop_id = p.stop_id
                WHERE p.observed_at <= a.actual_arrival
                  AND (a.actual_arrival - p.observed_at) BETWEEN 0 AND 1800
                  AND p.source IN ('model-v1','model-v2'))
     SELECT ${BUCKET.replace(/lead/g, "v1.lead")} AS lead_bucket,
            count(*) AS paired_n,
            CAST(avg(v1.ae) AS INTEGER) AS v1_mae,
            CAST(avg(v2.ae) AS INTEGER) AS v2_mae,
            CAST(avg(v1.err) AS INTEGER) AS v1_bias,
            CAST(avg(v2.err) AS INTEGER) AS v2_bias,
            CAST(100.0 * sum(CASE WHEN v2.ae < v1.ae THEN 1 ELSE 0 END) / count(*) AS INTEGER) AS v2_wins_pct
     FROM g v1
     JOIN g v2 ON v2.trip_id = v1.trip_id AND v2.stop_id = v1.stop_id
              AND v2.obs_min = v1.obs_min
              AND v1.source = 'model-v1' AND v2.source = 'model-v2'
     GROUP BY lead_bucket
     ORDER BY min(v1.lead)`
  );
  if (h2h.length === 0) {
    console.log("  (no paired v1/v2 predictions yet — run the backend with model-v2 live and let it accumulate)");
  } else {
    table(h2h, ["lead_bucket", "paired_n", "v1_mae", "v2_mae", "v1_bias", "v2_bias", "v2_wins_pct"]);
  }

  db.close();
}

main().catch((e) => {
  console.error("[backtest-report] FAILED:", e);
  process.exit(1);
});
