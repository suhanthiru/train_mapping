// Minimal static file server for web/dist (verification/preview only).
// The app fetches live data + WebSocket from the backend on :8080.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, resolve } from "node:path";

const DIST = resolve("D:/train_tracker/web/dist");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const fp = join(DIST, url === "/" ? "index.html" : normalize(url));
  if (!fp.startsWith(DIST)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const body = await readFile(fp);
    res.writeHead(200, { "Content-Type": MIME[extname(fp)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(4173, () => console.log("static dist on http://localhost:4173"));
