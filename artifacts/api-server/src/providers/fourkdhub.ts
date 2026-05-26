/**
 * 4KHDHub provider — scrapes 4khdhub.fans (redirects to 4khdhub.link).
 *
 * SITE STRUCTURE (as of 2025):
 *  Search:  /?s={title}+{year}  →  <a class="movie-card" href="/slug/">
 *           .movie-card-title   = title text
 *           .movie-card-meta    = year text
 *           .movie-card-format  = quality/genre badges (NOT "Movies"/"Series")
 *
 *  Detail:  /slug/  →  id="content-file{N}" divs, each containing:
 *           .file-title          = full filename (quality/audio info)
 *           a[href*="hubcloud"]  = direct HubCloud link (hubcloud.foo/drive/...)
 *           a[href*="hubdrive"]  = direct HubDrive link (hubdrive.space/file/...)
 *           Commented-out badge with file size (parsed when present)
 *
 *  Hub links are DIRECT — no redirect decode is needed.
 *  The existing extractors/hubcloud.ts handles hubcloud.foo URLs.
 */

import * as cheerio from "cheerio";
import { logger } from "../lib/logger.js";
import { extractHubCloud } from "../extractors/hubcloud.js";

const PROVIDER = "4KHDHub";
const BASE_URL = "https://4khdhub.fans";
const TIMEOUT = 15_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<cheerio.CheerioAPI | null> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctrl.signal,
    });
    clearTimeout(id);
    if (!res.ok) {
      logger.warn(`[${PROVIDER}] HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    return cheerio.load(await res.text());
  } catch (e: unknown) {
    logger.warn(`[${PROVIDER}] fetch failed: ${url.slice(0, 80)} — ${(e as Error).message}`);
    return null;
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i-1]![j]!+1, d[i]![j-1]!+1, d[i-1]![j-1]!+cost);
    }
  }
  return d[n]![m]!;
}

/** Extract quality label from a filename string. */
function qualityFromFilename(filename: string): string {
  if (/2160p|4K UHD|UHD BluRay|4k/i.test(filename)) return "4K";
  if (/1080p/i.test(filename)) return "1080p";
  if (/720p/i.test(filename)) return "720p";
  if (/480p/i.test(filename)) return "480p";
  return "";
}

/** Extract audio track info from a filename string. */
function audioFromFilename(filename: string): string {
  const m = filename.match(
    /\b(Hindi|English|Tamil|Telugu|Japanese|Bengali|Korean|Dual Language|Multi[\s-]?Audio)[^\])\n]*/i,
  );
  return m ? m[0].trim().replace(/\s+/g, " ") : "";
}

/** Try to parse file size from a commented-out or visible badge. */
function sizeFromHtml(html: string): string {
  const m = html.match(/(\d[\d.]*\s*[KMGT]B)/i);
  return m ? m[1]!.trim() : "";
}

// ── Search ────────────────────────────────────────────────────────────────────

async function findPageUrl(
  title: string,
  year: number,
): Promise<string | null> {
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(`${title} ${year}`)}`;
  logger.info(`[${PROVIDER}] searching: ${searchUrl}`);

  const $ = await fetchHtml(searchUrl);
  if (!$) return null;

  const titleLower = title.toLowerCase();
  let best: { href: string; dist: number } | null = null;

  $("a.movie-card").each((_i, el) => {
    const metaText = $(el).find(".movie-card-meta").text();
    const cardYear = parseInt(metaText, 10);
    if (isNaN(cardYear) || Math.abs(cardYear - year) > 1) return;

    const cardTitle = $(el)
      .find(".movie-card-title")
      .text()
      .replace(/\[.*?]/g, "")
      .trim();
    const dist = levenshtein(cardTitle.toLowerCase(), titleLower);
    if (dist >= 5) return;

    if (!best || dist < best.dist) {
      let href = $(el).attr("href") ?? "";
      if (href && !href.startsWith("http")) {
        href = BASE_URL + (href.startsWith("/") ? "" : "/") + href;
      }
      if (href) best = { href, dist };
    }
  });

  if (best) {
    logger.info(`[${PROVIDER}] found page: ${(best as { href: string; dist: number }).href} (dist=${(best as { href: string; dist: number }).dist})`);
    return (best as { href: string }).href;
  }
  logger.info(`[${PROVIDER}] no match found for "${title}" (${year})`);
  return null;
}

// ── Detail page parsing ───────────────────────────────────────────────────────

interface FileEntry {
  filename: string;
  hubCloudUrl: string | null;
  hubDriveUrl: string | null;
  rawHtml: string;
}

function parseFileEntries($: cheerio.CheerioAPI): FileEntry[] {
  const entries: FileEntry[] = [];

  $("[id^='content-file']").each((_i, el) => {
    const filename = $(el).find(".file-title").first().text().trim();
    if (!filename) return;

    const html = $.html(el);
    let hubCloudUrl: string | null = null;
    let hubDriveUrl: string | null = null;

    $(el).find("a[href]").each((_j, a) => {
      const href = $(a).attr("href") ?? "";
      const text = $(a).text().toLowerCase();
      if (!hubCloudUrl && (href.includes("hubcloud") || text.includes("hubcloud"))) {
        hubCloudUrl = href;
      } else if (!hubDriveUrl && (href.includes("hubdrive") || text.includes("hubdrive"))) {
        hubDriveUrl = href;
      }
    });

    entries.push({ filename, hubCloudUrl, hubDriveUrl, rawHtml: html });
  });

  return entries;
}

function filterEpisodeEntries(entries: FileEntry[], season: number, episode: number): FileEntry[] {
  const sTag = `S${String(season).padStart(2, "0")}`;
  const eTag = `E${String(episode).padStart(2, "0")}`;
  const altSeason = `Season ${season}`;
  const altEp = String(episode).padStart(2, "0");

  const matched = entries.filter((e) => {
    const upper = e.filename.toUpperCase();
    const full = `${sTag}${eTag}`;
    if (upper.includes(full)) return true;
    if (e.filename.includes(altSeason) && upper.includes(`E${altEp}`)) return true;
    if (new RegExp(`[\\s\\-_(E]0?${episode}[\\s\\-_)]`, "i").test(e.filename)) return true;
    return false;
  });

  return matched.length > 0 ? matched : entries;
}

// ── HubDrive resolver ─────────────────────────────────────────────────────────

async function resolveHubDrive(url: string): Promise<string | null> {
  try {
    const $ = await fetchHtml(url);
    if (!$) return url;

    const hcLink = $("a[href*='hubcloud']").first().attr("href");
    if (hcLink) return hcLink;

    const dlLink = $("a[href]")
      .filter((_i, a) => /download|direct|get/i.test($(a).text()))
      .first()
      .attr("href");
    if (dlLink) return dlLink;

    return url;
  } catch {
    return url;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FourkdStream {
  name: string;
  title: string;
  url: string;
  behaviorHints: { bingeGroup: string; notWebReady: boolean };
}

export async function getFourkdHubStreams(
  contentTitle: string,
  contentYear: number | undefined,
  type: string,
  season?: number,
  episode?: number,
): Promise<FourkdStream[]> {
  const year = contentYear ?? new Date().getFullYear();
  const isSeries = type === "series" || type === "tv";

  logger.info({ title: contentTitle, year, type, season, episode }, `[${PROVIDER}] start`);

  const pageUrl = await findPageUrl(contentTitle, year);
  if (!pageUrl) return [];

  const $ = await fetchHtml(pageUrl);
  if (!$) return [];

  let entries = parseFileEntries($);
  logger.info(`[${PROVIDER}] found ${entries.length} file entries`);

  if (!entries.length) return [];

  if (isSeries && season != null && episode != null) {
    entries = filterEpisodeEntries(entries, season, episode);
    logger.info(`[${PROVIDER}] after episode filter: ${entries.length} entries`);
  }

  const results: FourkdStream[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      const quality = qualityFromFilename(entry.filename);
      const audio   = audioFromFilename(entry.filename);
      const size    = sizeFromHtml(entry.rawHtml);

      const nameBadge = `${PROVIDER} | ${quality || "HD"}`;
      const titleLines = [entry.filename, size].filter(Boolean).join("\n");

      if (entry.hubCloudUrl) {
        try {
          logger.info(`[${PROVIDER}] extracting HubCloud: ${entry.hubCloudUrl}`);
          const streams = await extractHubCloud(entry.hubCloudUrl, PROVIDER);
          for (const s of streams) {
            results.push({
              name: `${nameBadge}\n${s.name}`,
              title: titleLines,
              url: s.url,
              behaviorHints: { bingeGroup: `4khdhub-hc`, notWebReady: false },
            });
          }
        } catch (e: unknown) {
          logger.warn(`[${PROVIDER}] HubCloud failed: ${(e as Error).message}`);
        }
      }

      if (entry.hubDriveUrl && results.length === 0) {
        try {
          logger.info(`[${PROVIDER}] resolving HubDrive: ${entry.hubDriveUrl}`);
          const resolved = await resolveHubDrive(entry.hubDriveUrl);
          if (resolved) {
            if (resolved.includes("hubcloud")) {
              const streams = await extractHubCloud(resolved, PROVIDER);
              for (const s of streams) {
                results.push({
                  name: `${nameBadge}\n${s.name}`,
                  title: titleLines,
                  url: s.url,
                  behaviorHints: { bingeGroup: `4khdhub-hd`, notWebReady: false },
                });
              }
            } else {
              const badge = [quality, audio].filter(Boolean).join(" | ") || "Unknown";
              results.push({
                name: `${nameBadge} | ${badge}`,
                title: titleLines,
                url: resolved,
                behaviorHints: { bingeGroup: `4khdhub-hd`, notWebReady: false },
              });
            }
          }
        } catch (e: unknown) {
          logger.warn(`[${PROVIDER}] HubDrive failed: ${(e as Error).message}`);
        }
      }
    }),
  );

  logger.info(`[${PROVIDER}] done — ${results.length} streams`);
  return results;
}
