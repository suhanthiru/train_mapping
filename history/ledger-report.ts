// Standalone report over the accumulated data — no server needed. Prints:
//   1. ETA accuracy curve: feed-prediction MAE + bias vs. lead time (from ledger.db)
//   2. Speed calibration: predicted vs. realized speed error (from history.db),
//      the tuning signal for the interpolation constants / "is a Kalman filter
//      worth it?" evidence. Realized speed = Δdist/Δt between consecutive ticks.
//
// Run: npm run report:accuracy

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { PredictionLedger } from "./ledger.ts";

const DATA_DIR = join(process.cwd(), "data");

function reportAccuracy() {
  const ledger = new PredictionLedger(join(DATA_DIR, "ledger.db"));
  const counts = ledger.counts();
  console.log("\n=== ETA prediction accuracy (feed vs. actual) ===");
  console.log(
    `ledger rows: ${counts.predictions} predictions, ${counts.actuals} actuals, ${counts.conditions} weather samples`
  );
  const buckets = ledger.accuracyByLeadTime("gtfs-rt");
  const total = buckets.reduce((s, b) => s + b.n, 0);
  if (total === 0) {
    console.log("no matched (prediction, actual) pairs yet — let it collect and run again.");
    console.log("(actuals need trains to be observed STOPPED_AT a stop, so give it ~30-60 min.)");
  } else {
    console.log("lead time   n        MAE      bias (pred - actual)");
    for (const b of buckets) {
      console.log(
        `${b.leadLabel.padEnd(10)}  ${String(b.n).padStart(6)}   ${String(b.maeSec).padStart(4)}s   ${b.biasSec >= 0 ? "+" : ""}${b.biasSec}s`
      );
    }
    console.log("(sanity: MAE should grow with lead time — further-out predictions are worse)");
  }
  ledger.close();
}

function reportSpeedCalibration() {
  console.log("\n=== Speed calibration (predicted vs. realized) ===");
  const db = new DatabaseSync(join(DATA_DIR, "history.db"));
  // Pull recent snapshots, ordered per vehicle by time, and compare each row's
  // logged (predicted) speed to the realized speed = Δdist / Δt to the next row.
  const rows = db
    .prepare(
      `SELECT ts, vehicleId, dist, speed FROM snapshots
       WHERE ts > ? ORDER BY vehicleId, ts`
    )
    .all(Math.floor(Date.now() / 1000) - 3 * 3600) as {
    ts: number;
    vehicleId: string;
    dist: number;
    speed: number;
  }[];

  let n = 0;
  let sumAbsErr = 0;
  const absErrs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.vehicleId !== b.vehicleId) continue;
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > 30) continue; // consecutive ticks only
    const realized = (b.dist - a.dist) / dt;
    if (realized < 0 || realized > 30) continue; // ignore shape-switch/teleport artifacts
    const err = Math.abs(a.speed - realized);
    sumAbsErr += err;
    absErrs.push(err);
    n++;
  }
  db.close();

  if (n === 0) {
    console.log("no usable consecutive-tick pairs in history.db yet.");
    return;
  }
  absErrs.sort((x, y) => x - y);
  const mean = sumAbsErr / n;
  const median = absErrs[Math.floor(absErrs.length / 2)];
  const p90 = absErrs[Math.floor(absErrs.length * 0.9)];
  console.log(`samples: ${n}`);
  console.log(`mean |predicted - realized| speed error: ${mean.toFixed(2)} m/s`);
  console.log(`median: ${median.toFixed(2)} m/s   p90: ${p90.toFixed(2)} m/s`);
  console.log("(this is the number a Kalman filter / tuned constants would aim to reduce)");
}

reportAccuracy();
reportSpeedCalibration();
console.log("");
