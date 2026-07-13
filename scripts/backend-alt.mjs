// Launch the backend on an alternate port (default 8180) — lets a second
// instance run for preview/verification while the primary holds :8080.
// Used by .claude/launch.json ("backend-alt").
import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const child = spawn(
  process.execPath,
  [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "server", "index.ts")],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, PORT: process.env.ALT_PORT ?? "8180" } }
);
child.on("exit", (code) => process.exit(code ?? 0));
