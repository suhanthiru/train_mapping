// Export the ledger's analytical data to portable, universally-consumable
// formats: the station GRAPH (nodes + edges) for network analysis, and the
// feature/training tables — as Parquet (columnar, compressed, the data-lake
// standard) and CSV. DuckDB attaches the SQLite ledger read-only and COPYs out,
// so this never contends with the live backend writing to ledger.db.
//
// Run: npm run export:data (everything) | npm run export:graph (graph only)

import duckdb from "duckdb";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");
const OUT = join(DATA, "exports");
const LEDGER = join(DATA, "ledger.db").replace(/\\/g, "/");
const what = process.argv[2] ?? "all"; // "graph" | "data" | "all"

const db = new duckdb.Database(":memory:");
const run = (sql: string): Promise<any[]> =>
  new Promise((res, rej) => db.all(sql, (e: Error | null, r: any[]) => (e ? rej(e) : res(r))));

function csvEsc(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const out = (f: string) => join(OUT, f).replace(/\\/g, "/");

  await run("INSTALL sqlite; LOAD sqlite;");
  await run(`ATTACH '${LEDGER}' AS led (TYPE SQLITE, READ_ONLY)`);

  // write a query to both Parquet and CSV, log the row count
  const both = async (name: string, select: string) => {
    await run(`COPY (${select}) TO '${out(name + ".parquet")}' (FORMAT PARQUET)`);
    await run(`COPY (${select}) TO '${out(name + ".csv")}' (FORMAT CSV, HEADER)`);
    const c = (await run(`SELECT count(*) AS c FROM (${select})`))[0].c;
    console.log(`  wrote ${name}.{parquet,csv}  (${c} rows)`);
  };

  if (what === "graph" || what === "all") {
    console.log("[export] graph (nodes + edges)...");
    // edges: weighted directed graph aggregated from segment traversals
    await both(
      "edges",
      `SELECT from_stop, to_stop, route_id AS route,
              CAST(median(travel_sec) AS INTEGER) AS median_travel_sec,
              count(*) AS n
       FROM led.segments
       GROUP BY from_stop, to_stop, route_id`
    );

    // nodes: stops that actually appear in the network, enriched from stops.json
    // (collapse platform-level id -> parent_station for a clean station graph)
    const stopRows = await run(
      `SELECT DISTINCT s FROM (
         SELECT from_stop AS s FROM led.segments
         UNION SELECT to_stop AS s FROM led.segments)`
    );
    const stops = JSON.parse(readFileSync(join(DATA, "nyc", "stops.json"), "utf8"));
    let nodesCsv = "stop_id,parent_station,name,lon,lat\n";
    for (const { s } of stopRows) {
      const st = stops[s] ?? {};
      const parent = st.parent || s;
      const [lon, lat] = st.pos ?? ["", ""];
      nodesCsv += [s, parent, csvEsc(st.name ?? s), lon, lat].join(",") + "\n";
    }
    writeFileSync(out("nodes.csv"), nodesCsv);
    await run(
      `COPY (SELECT * FROM read_csv_auto('${out("nodes.csv")}')) TO '${out("nodes.parquet")}' (FORMAT PARQUET)`
    );
    console.log(`  wrote nodes.{csv,parquet}  (${stopRows.length} stations)`);
  }

  if (what === "data" || what === "all") {
    console.log("[export] data tables...");
    await both("segments", "SELECT * FROM led.segments");
    await both("actuals", "SELECT * FROM led.actuals");
    await both("conditions", "SELECT * FROM led.conditions");
    await both("predictions_sample", "SELECT * FROM led.predictions USING SAMPLE 20000 ROWS");
  }

  console.log(`[export] done -> ${OUT}`);
  db.close();
}

main().catch((e) => {
  console.error("[export] FAILED:", e);
  process.exit(1);
});
