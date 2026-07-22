// One-command dev startup: `npm run dev:all` brings up every service with
// name-prefixed logs and kills the whole tree together on Ctrl+C / exit.
// Zero dependencies (hand-rolled instead of `concurrently` because Windows
// needs taskkill /T for tree-kill — tsx watch and vite both spawn children
// that a plain child.kill() would orphan, leaving ports held).
//
// Services (ports authoritative in shared/config.ts — this plain-.mjs launcher
// can't import TS, so keep the two in sync; hub page at :8088/hub lists them):
//   kalman     :8092  prebuilt exe if present, else cargo run --release
//   analytics  :8091  python app.py (FastAPI)
//   backend    :8088  tsx watch server/index.ts
//   dashboard  :4174  node dashboard/serve.mjs
//   web        :5173  vite dev server (HMR; prod path serves web/dist on :8088)
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const IS_WIN = process.platform === "win32";
const COLORS = { kalman: 35, analytics: 36, backend: 32, dashboard: 33, web: 34 }; // ANSI

const kalmanExe = join(ROOT, "kalman-rs", "target", "release", IS_WIN ? "kalman-rs.exe" : "kalman-rs");
const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const SERVICES = [
  {
    name: "kalman",
    ...(existsSync(kalmanExe)
      ? { cmd: kalmanExe, args: [], cwd: join(ROOT, "kalman-rs") }
      : { cmd: "cargo", args: ["run", "--release"], cwd: join(ROOT, "kalman-rs"), shell: true }),
  },
  { name: "analytics", cmd: "python", args: ["app.py"], cwd: join(ROOT, "analytics-py"), shell: true },
  { name: "backend", cmd: process.execPath, args: [tsxCli, "watch", "server/index.ts"], cwd: ROOT },
  { name: "dashboard", cmd: process.execPath, args: [join(ROOT, "dashboard", "serve.mjs")], cwd: ROOT },
  { name: "web", cmd: "npm", args: ["run", "dev"], cwd: join(ROOT, "web"), shell: true },
];

const children = [];
let shuttingDown = false;

function prefix(name, data, err = false) {
  const c = COLORS[name] ?? 37;
  const tag = `\x1b[${c}m[${name.padEnd(9)}]\x1b[0m`;
  for (const line of data.toString().split(/\r?\n/)) {
    if (line.trim()) (err ? process.stderr : process.stdout).write(`${tag} ${line}\n`);
  }
}

function start({ name, cmd, args, cwd, shell }) {
  const child = spawn(cmd, args, { cwd, shell: !!shell, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => prefix(name, d));
  child.stderr.on("data", (d) => prefix(name, d, true));
  child.on("exit", (code) => {
    prefix(name, `exited (code ${code})`, code !== 0);
    // one service dying (e.g. port already in use) shouldn't leave a half-up
    // stack silently — take everything down so the failure is obvious.
    if (!shuttingDown) shutdown(`${name} exited`);
  });
  children.push({ name, child });
  prefix(name, `started (pid ${child.pid})`);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev-all] shutting down (${reason}) …`);
  for (const { name, child } of children) {
    if (child.exitCode !== null) continue;
    try {
      if (IS_WIN) {
        // /T kills the whole tree (tsx/vite child processes), /F forces.
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch { /* already gone */ }
    prefix(name, "stopped");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("Ctrl+C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("[dev-all] starting all services — hub at http://localhost:8088/hub\n");
for (const s of SERVICES) start(s);
