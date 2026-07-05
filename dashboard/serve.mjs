// Minimal static server for the analytics dashboard (:4174). Decoupled from the
// 3D app — it fetches the live services (backend :8080, kalman :8092,
// analytics-py :8091) over CORS. Run: node dashboard/serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const ROOT = import.meta.dirname; // this script's own dir — portable (native + Docker)
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const fp = join(ROOT, url === "/" ? "index.html" : normalize(url));
  if (!fp.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const body = await readFile(fp);
    res.writeHead(200, { "Content-Type": MIME[extname(fp)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(4174, () => console.log("dashboard on http://localhost:4174"));
