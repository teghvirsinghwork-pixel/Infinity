import { logger } from "./logger.js";

export const TTL_MS_DEFAULT = 30 * 60 * 1000;
const MAX_ENTRIES = 300;

interface CacheEntry {
  streams: Record<string, unknown>[];
  cachedAt: number;
  expiresAt: number;
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();

export function streamCacheKey(
  id: string,
  type: string,
  season: number,
  episode: number,
): string {
  return `${type}:${id}:${season}:${episode}`;
}

export function getStreamCache(key: string): Record<string, unknown>[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    logger.debug({ key }, "StreamCache: entry expired");
    return null;
  }
  const ageSeconds = Math.round((Date.now() - entry.cachedAt) / 1000);
  logger.info({ key, ageSeconds, count: entry.streams.length, ttlMs: entry.ttlMs }, "StreamCache: HIT");
  return entry.streams;
}

export function setStreamCache(
  key: string,
  streams: Record<string, unknown>[],
  ttlMs: number = TTL_MS_DEFAULT,
): void {
  if (!streams.length) return;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  const now = Date.now();
  cache.set(key, {
    streams,
    cachedAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
  });

  const ttlMin = Math.round(ttlMs / 60_000);
  logger.info({ key, count: streams.length, ttlMin }, "StreamCache: SET");
}

export function streamCacheStats(): { size: number; maxEntries: number } {
  return { size: cache.size, maxEntries: MAX_ENTRIES };
}
