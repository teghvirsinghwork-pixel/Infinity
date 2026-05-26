import { ProxyAgent } from "undici";
import { logger } from "./logger.js";

// ─── Free proxy pool ──────────────────────────────────────────────────────────
// Fetches fresh public HTTPS proxies at startup and after each refresh interval.
// Used for geo-restricted providers (MovieBox) that block specific regions.
// Cloudflare-protected sites need the TLS fingerprint change, not a proxy.

const REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 25 min — proxies expire fast

// Multiple free sources for redundancy
const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite&simplified=true",
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=anonymous&simplified=true",
];

interface PoolEntry {
  url: string;
  failCount: number;
  working: boolean;
}

let pool: PoolEntry[] = [];
let poolIdx = 0;
let lastRefresh = 0;

// ─── Fetch raw IP:PORT list from one source ───────────────────────────────────
async function fetchSource(sourceUrl: string): Promise<string[]> {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    return text
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
      .map((l) => `http://${l}`);
  } catch {
    return [];
  }
}

// ─── Test a proxy by fetching a neutral HTTPS endpoint ───────────────────────
async function testProxy(proxyUrl: string): Promise<boolean> {
  try {
    const agent = new ProxyAgent({
      uri: proxyUrl,
      connect: { rejectUnauthorized: false },
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7_000);
    const res = await fetch("https://httpbin.org/ip", {
      dispatcher: agent as unknown as RequestInit["dispatcher"],
      signal: ctrl.signal,
    } as RequestInit);
    clearTimeout(t);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ─── Refresh proxy pool (runs in background, non-blocking) ───────────────────
export async function refreshProxyPool(): Promise<void> {
  logger.info("ProxyPool: fetching free proxy lists…");
  const lists = await Promise.all(PROXY_SOURCES.map(fetchSource));
  const all = [...new Set(lists.flat())];

  if (all.length === 0) {
    logger.warn("ProxyPool: no proxies fetched from any source");
    return;
  }

  logger.info({ total: all.length }, "ProxyPool: testing proxies in parallel…");

  // Test first 40 candidates in parallel (fast batch)
  const batch = all.slice(0, 40);
  const results = await Promise.allSettled(
    batch.map(async (url) => ({ url, ok: await testProxy(url) })),
  );

  const working = results
    .filter(
      (r): r is PromiseFulfilledResult<{ url: string; ok: boolean }> =>
        r.status === "fulfilled" && r.value.ok,
    )
    .map((r) => r.value.url);

  pool = working.map((url) => ({ url, failCount: 0, working: true }));
  poolIdx = 0;
  lastRefresh = Date.now();
  logger.info({ working: pool.length, tested: batch.length }, "ProxyPool: ready");
}

// ─── Start background refresh loop ───────────────────────────────────────────
export function startProxyPool(): void {
  // First refresh after 5 s so it doesn't slow server startup
  setTimeout(async () => {
    await refreshProxyPool().catch(() => {});
    setInterval(() => refreshProxyPool().catch(() => {}), REFRESH_INTERVAL_MS);
  }, 5_000);
}

// ─── Get next working proxy URL ───────────────────────────────────────────────
export function getNextProxy(): string | null {
  const working = pool.filter((p) => p.working);
  if (working.length === 0) return null;
  const entry = working[poolIdx % working.length];
  poolIdx++;
  return entry.url;
}

// ─── Mark a proxy as failed; remove after 3 failures ─────────────────────────
export function markProxyFailed(proxyUrl: string): void {
  const entry = pool.find((p) => p.url === proxyUrl);
  if (!entry) return;
  entry.failCount++;
  if (entry.failCount >= 3) {
    entry.working = false;
    logger.info({ proxy: proxyUrl }, "ProxyPool: evicted after 3 failures");
  }
}

// ─── proxyFetch — drop-in fetch() replacement that uses the pool ──────────────
export async function proxyFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const proxyUrl = getNextProxy();
  if (!proxyUrl) {
    // Pool empty — direct request
    return fetch(url, init);
  }
  try {
    const agent = new ProxyAgent({
      uri: proxyUrl,
      connect: { rejectUnauthorized: false },
    });
    const res = await fetch(url, {
      ...init,
      dispatcher: agent as unknown as RequestInit["dispatcher"],
    } as RequestInit);
    return res;
  } catch (err) {
    markProxyFailed(proxyUrl);
    logger.debug({ proxyUrl, url }, "ProxyPool: proxy failed, retrying direct");
    return fetch(url, init); // fallback to direct
  }
}

// ─── Pool status for health check ────────────────────────────────────────────
export function proxyPoolStatus(): { size: number; lastRefreshAgo: string } {
  const ago =
    lastRefresh === 0
      ? "never"
      : `${Math.round((Date.now() - lastRefresh) / 1000)}s ago`;
  return { size: pool.filter((p) => p.working).length, lastRefreshAgo: ago };
}
