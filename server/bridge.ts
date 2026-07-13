// Resilient HTTP client for the model bridge (roadmap P3). Before this, a down
// analytics-py cost the tick loop the FULL abort timeout on every call, every
// 30s tick (5s + 5s), forever — no retry on transient blips, no backing off
// when the service is actually down.
//
// Per-endpoint circuit breaker:
//   CLOSED   normal; a transient failure gets ONE quick retry
//   OPEN     after OPEN_AFTER consecutive failures: calls return null
//            immediately (no socket, no timeout burn)
//   HALF-OPEN after PROBE_EVERY_MS: the next call goes through as the probe;
//            success closes the circuit, failure re-opens it
//
// Callers treat null as "no result this tick" — the same quiet-skip the raw
// fetch code already did, so degraded behavior is unchanged, just cheaper.

interface Circuit {
  failures: number;
  openedAt: number; // 0 = closed
}

const OPEN_AFTER = 3;          // consecutive failures before opening
const PROBE_EVERY_MS = 60_000; // half-open probe cadence while open
const RETRY_ONCE_DELAY_MS = 250;

const circuits = new Map<string, Circuit>();

function circuit(key: string): Circuit {
  let c = circuits.get(key);
  if (!c) {
    c = { failures: 0, openedAt: 0 };
    circuits.set(key, c);
  }
  return c;
}

/** POST JSON; parse JSON reply. Returns null on any failure (caller skips). */
export async function postJson<T>(
  url: string,
  body: unknown,
  { timeoutMs = 5000, name = url }: { timeoutMs?: number; name?: string } = {}
): Promise<T | null> {
  const c = circuit(name);

  if (c.openedAt) {
    if (Date.now() - c.openedAt < PROBE_EVERY_MS) return null; // open — fail fast
    // half-open: fall through, this call is the probe
  }

  const attempt = async (): Promise<T | null> => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null; // 4xx/5xx: service alive but declining (e.g. model not trained) — not a circuit failure
    return (await r.json()) as T;
  };

  try {
    const out = await attempt();
    c.failures = 0;
    if (c.openedAt) {
      c.openedAt = 0;
      console.log(`[bridge] ${name}: circuit closed (probe succeeded)`);
    }
    return out;
  } catch {
    // one quick retry for transient blips — only while the circuit is closed
    if (!c.openedAt) {
      try {
        await new Promise((res) => setTimeout(res, RETRY_ONCE_DELAY_MS));
        const out = await attempt();
        c.failures = 0;
        return out;
      } catch { /* fall through to failure accounting */ }
    }
    c.failures++;
    if (c.openedAt || c.failures >= OPEN_AFTER) {
      if (!c.openedAt) console.error(`[bridge] ${name}: circuit OPEN after ${c.failures} consecutive failures`);
      c.openedAt = Date.now();
    }
    return null;
  }
}

/** For /health-style observability. */
export function bridgeStatus() {
  const out: Record<string, { failures: number; open: boolean }> = {};
  for (const [k, c] of circuits) out[k] = { failures: c.failures, open: c.openedAt > 0 };
  return out;
}
