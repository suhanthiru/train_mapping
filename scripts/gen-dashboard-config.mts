// Generates dashboard/config.js from shared/config.ts (roadmap P3).
// dashboard/app.js has no build step and can't import TS, so the single source
// of truth is materialized into a tiny checked-in global. Regenerate after
// editing shared/config.ts:  npm run gen:config
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORTS, COLORS } from "../shared/config.ts";

const out = `// GENERATED from shared/config.ts — do not edit by hand.
// Regenerate with: npm run gen:config
window.TT_CONFIG = ${JSON.stringify({ ports: PORTS, colors: COLORS }, null, 2)};
`;

const path = join(import.meta.dirname, "..", "dashboard", "config.js");
writeFileSync(path, out);
console.log(`[gen:config] wrote ${path}`);
