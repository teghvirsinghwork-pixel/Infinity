import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import { logger } from "../lib/logger.js";

const PROVIDER_NAME = "ZinkMovies";
let MAIN_URL = "https://new8.zinkmovies.biz";
const DOMAINS_URL = "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const HRUJO_KEY = "1EN-Yy+CfM39lPQMhPhiCSKDaYA6mRO++nHNRq9ZfhtGHPwC8DWQq9q5IGK49Iqc";
const TIMEOUT = 10000;
const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection": "keep-alive",
};

let visitedUrls = new Set<string>();
let processedFiles = new Set<string>();

async function resolveDomain(): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(DOMAINS_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json() as Record<string, string>;
    if (data["zinkmovies"] && typeof data["zinkmovies"] === "string") {
      MAIN_URL = data["zinkmovies"];
    }
  } catch { /* keep default */ }
}

void resolveDomain();

async function fetchSafe(url: string, options: RequestInit = {}): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const merged: RequestInit = { ...options, headers: { ...HEADERS, ...(options.headers as Record<string, string> || {}) }, signal: ctrl.signal };
    const res = await fetch(url, merged);
    clearTimeout(timer);
    return res;
  } catch (e: any) {
    logger.error(`[${PROVIDER_NAME}] fetchSafe error: ${url.substring(0, 100)} -> ${e.message}`);
    return null;
  }
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  const res = await fetchSafe(url, options);
  if (!res || !res.ok) return null;
  try { return JSON.parse(await res.text()); } catch { return null; }
}

async function fetchHtml(url: string, options: RequestInit = {}): Promise<cheerio.CheerioAPI | null> {
  const res = await fetchSafe(url, options);
  if (!res || !res.ok) return null;
  try { return cheerio.load(await res.text()); } catch { return null; }
}

function parseQuality(text: string): string {
  const t = (text || "").toUpperCase();
  if (t.includes("2160") || t.includes("4K") || t.includes("UHD")) return "2160P";
  if (t.includes("1080")) return "1080P";
  if (t.includes("720")) return "720P";
  if (t.includes("480")) return "480P";
  return "HD";
}

function similarity(s1: string, s2: string, year?: string): number {
  if (!s1 || !s2) return 0;
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const w1 = clean(s1), w2 = clean(s2), w2Set = new Set(w2);
  const intersection = w1.filter((x) => w2Set.has(x)).length;
  let score = intersection / Math.max(w1.length, 1);
  if (w1.length <= 4 && score > 0) {
    if (!s2.toLowerCase().startsWith(s1.toLowerCase().substring(0, Math.min(s1.length, s2.length)))) score = Math.max(0, score - 0.5);
  }
  if (year && String(s2).includes(String(year))) score += 0.3;
  if (s2.toLowerCase().startsWith(s1.toLowerCase())) score += 0.2;
  return Math.min(score, 1);
}

function dedupe(streams: any[]): any[] {
  const seen = new Set<string>();
  return (streams || []).filter((s) => { if (!s || !s.url || seen.has(s.url)) return false; seen.add(s.url); return true; });
}

function makeStream(name: string, title: string, url: string, quality: string, headers: Record<string, string> = {}): any {
  return {
    name: `ALLINONE | ${PROVIDER_NAME} | ${name}`,
    title,
    url,
    behaviorHints: { notWebReady: false, proxyHeaders: { request: { "User-Agent": HEADERS["User-Agent"], ...headers } } },
  };
}

function getOrigin(url: string): string {
  try { const parts = url.split("//"); return parts.length < 2 ? url : parts[0] + "//" + parts[1].split("/")[0]; } catch { return url; }
}

async function getTMDBInfo(id: string, type: string): Promise<{ title: string; year: string; imdbId: string | null }> {
  const idStr = String(id || "").trim();
  const isImdb = idStr.startsWith("tt");
  const tmdbType = type === "tv" || type === "series" ? "tv" : "movie";
  try {
    if (isImdb) {
      const data = await fetchJson(`https://api.themoviedb.org/3/find/${idStr}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
      const list = data ? (tmdbType === "tv" ? data.tv_results : data.movie_results) : null;
      if (list && list.length > 0) {
        const item = list[0];
        return { title: tmdbType === "tv" ? item.name : item.title, year: (item.first_air_date || item.release_date || "").split("-")[0], imdbId: idStr };
      }
      return { title: idStr, year: "", imdbId: idStr };
    } else {
      const data = await fetchJson(`https://api.themoviedb.org/3/${tmdbType}/${idStr}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
      if (data) {
        const imdbId = data.imdb_id || data.external_ids?.imdb_id || null;
        return { title: tmdbType === "tv" ? data.name : data.title, year: (data.first_air_date || data.release_date || "").split("-")[0], imdbId };
      }
    }
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] TMDB error: ${e.message}`); }
  return { title: idStr, year: "", imdbId: null };
}

async function searchSite(title: string): Promise<{ title: string; href: string; year: string | null }[]> {
  const url = `${MAIN_URL}/?s=${encodeURIComponent(title)}`;
  logger.info(`[${PROVIDER_NAME}] Search: ${url}`);
  const $ = await fetchHtml(url);
  if (!$) return [];
  const results: { title: string; href: string; year: string | null }[] = [];
  const seen = new Set<string>();
  $('a[href*="zinkmovies.biz/movies/"], a[href*="zinkmovies.biz/series/"]').each((_: number, el: any) => {
    const href = $(el).attr("href") || "";
    if (!href || seen.has(href)) return;
    seen.add(href);
    // Prefer img alt for the title (e.g. "Avengers Endgame (2019)"), fall back to URL slug
    const imgAlt = $(el).find("img").attr("alt") || "";
    const slug = (href.split("/movies/")[1] || href.split("/series/")[1] || "").replace(/\/$/, "");
    const slugTitle = slug.replace(/-(\d{4})$/, "").replace(/-/g, " ").trim();
    const itemTitle = imgAlt || slugTitle;
    if (!itemTitle) return;
    const year = (imgAlt.match(/\((\d{4})\)/) || slug.match(/-(\d{4})$/) || [null, null])[1];
    results.push({ title: itemTitle, href, year });
  });
  logger.info(`[${PROVIDER_NAME}] Found ${results.length} search results`);
  return results;
}

function extractBraceObject(str: string, startIdx: number): string | null {
  if (str[startIdx] !== "{") return null;
  let depth = 0, inString = false, escape = false;
  for (let i = startIdx; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"' && !inString) { inString = true; continue; }
    if (c === '"' && inString) { inString = false; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (depth === 0) return str.substring(startIdx, i + 1);
  }
  return null;
}

function decryptPlaylist(encryptedText: string, p3Key: string): string {
  if (!encryptedText || !p3Key || p3Key.length < 16) return encryptedText;
  const ivStr = p3Key.substring(0, 16);
  try {
    const key = CryptoJS.enc.Base64.parse(HRUJO_KEY);
    const iv = CryptoJS.enc.Utf8.parse(ivStr);
    const decrypted = CryptoJS.AES.decrypt(encryptedText, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (result && result.length > 0) return result;
  } catch {}
  try {
    const key = CryptoJS.enc.Utf8.parse(p3Key.substring(0, 32));
    const iv = CryptoJS.enc.Utf8.parse(ivStr);
    const decrypted = CryptoJS.AES.decrypt(encryptedText, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (result && result.length > 0) return result;
  } catch {}
  return encryptedText;
}

async function resolveEmbed(imdbId: string, label: string, isTv: boolean, season?: number, episode?: number): Promise<any[]> {
  if (!imdbId) return [];
  try {
    let playerUrl = `https://hrujo406fix.com/play/${imdbId}`;
    if (isTv && season && episode) playerUrl += `?s=${season}&e=${episode}`;
    logger.info(`[${PROVIDER_NAME}] Embed: fetching ${playerUrl}`);
    const res = await fetchSafe(playerUrl, { headers: { ...HEADERS, "Referer": `${MAIN_URL}/`, "Origin": MAIN_URL } });
    if (!res || !res.ok) return [];
    const html = await res.text();
    let p3Raw: string | null = null;
    for (const pat of ["let p3 = ", "var p3 = ", "const p3 = ", "window.p3 = ", "p3 = "]) {
      const idx = html.indexOf(pat);
      if (idx >= 0) {
        const braceIdx = html.indexOf("{", idx + pat.length);
        if (braceIdx >= 0) { p3Raw = extractBraceObject(html, braceIdx); if (p3Raw) break; }
      }
    }
    if (!p3Raw) return [];
    let p3: any;
    try { p3 = JSON.parse(p3Raw); } catch { try { p3 = JSON.parse(p3Raw.replace(/\\\//g, "/")); } catch { return []; } }
    if (!p3.file || !p3.key) return [];
    let currentUrl = "";
    if (isTv && typeof p3.file === "object" && p3.file !== null) {
      const s = String(season || 1), e = String(episode || 1);
      let hash = "";
      if (Array.isArray(p3.file)) {
        for (const entry of p3.file) {
          if (entry && String(entry[0]) === s && String(entry[1]) === e && entry[2]) { hash = entry[2]; break; }
        }
      } else {
        const seasonObj = p3.file[s];
        if (seasonObj && seasonObj[e]) hash = seasonObj[e];
      }
      if (!hash) return [];
      currentUrl = `https://hrujo406fix.com/playlist/${hash}.txt`;
    } else {
      currentUrl = p3.file.startsWith("http") ? p3.file : `https://hrujo406fix.com${p3.file}`;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const fRes = await fetchSafe(currentUrl, {
        method: "POST",
        headers: { ...HEADERS, "Referer": playerUrl, "X-CSRF-TOKEN": p3.key, "X-Requested-With": "XMLHttpRequest" },
      });
      if (!fRes || !fRes.ok) break;
      const data = (await fRes.text()).trim();
      let finalUrl = decryptPlaylist(data, p3.key);
      if (data.startsWith("[") || data.startsWith("{")) {
        try {
          const json = JSON.parse(data);
          const findFile = (obj: any): string => {
            if (!obj) return "";
            if (obj.file) return obj.file;
            if (obj.folder && Array.isArray(obj.folder) && obj.folder.length > 0) {
              for (const f of obj.folder) { const r = findFile(f); if (r) return r; }
            }
            return "";
          };
          const item = Array.isArray(json) ? json[0] : json;
          finalUrl = findFile(item) || "";
        } catch { break; }
      }
      if (!finalUrl) break;
      if (finalUrl.startsWith("~")) { currentUrl = `https://hrujo406fix.com/playlist/${finalUrl.substring(1)}.txt`; continue; }
      if (finalUrl.includes("m3u8") || finalUrl.includes(".mp4")) {
        return [makeStream("Embed", `${label} [HLS]`, finalUrl, "Multi", { "Referer": "https://hrujo406fix.com/" })];
      }
      break;
    }
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] Embed fatal: ${e.message}`); }
  return [];
}

async function resolveHubCloud(url: string, label: string, quality: string): Promise<any[]> {
  if (visitedUrls.has(url)) return [];
  visitedUrls.add(url);
  try {
    logger.info(`[${PROVIDER_NAME}] HubCloud: landing ${url.substring(0, 80)}`);
    const hubHeaders = { ...HEADERS, "Referer": `${MAIN_URL}/`, "Cookie": "xla=s4t" };
    const $ = await fetchHtml(url, { headers: hubHeaders });
    if (!$) { logger.info(`[${PROVIDER_NAME}] HubCloud: landing fetch failed`); return []; }
    const html = $.html();

    // Find bridge URL from JS: var url = '...'
    const varMatch = html.match(/var url\s*=\s*['"]([^'"]+)['"]/);
    if (!varMatch) { logger.info(`[${PROVIDER_NAME}] HubCloud: no bridge URL in landing page`); return []; }
    const bridgeUrl = varMatch[1];
    logger.info(`[${PROVIDER_NAME}] HubCloud: bridge -> ${bridgeUrl.substring(0, 100)}`);

    const $b = await fetchHtml(bridgeUrl, { headers: { ...HEADERS, "Referer": url, "Cookie": "xla=s4t" } });
    if (!$b) { logger.info(`[${PROVIDER_NAME}] HubCloud: bridge fetch failed`); return []; }

    const bridgeHtml = $b.html();
    const headerText = $b("div.card-header").text().trim();
    const detectedQuality = parseQuality(headerText) || quality;

    const streams: any[] = [];

    // Extract pixeldrain link from JS: var pxl = "..."
    const pxlMatch = bridgeHtml.match(/var pxl\s*=\s*["'](https?:\/\/[^"']+)["']/);
    if (pxlMatch) {
      const pxlUrl = pxlMatch[1];
      const pxlId = pxlUrl.split("/u/")[1]?.split(/[?#]/)[0];
      if (pxlId) {
        // Use pixeldrain API for direct streaming
        const directUrl = `https://pixeldrain.com/api/file/${pxlId}`;
        logger.info(`[${PROVIDER_NAME}] HubCloud: pixeldrain stream found (${detectedQuality})`);
        streams.push(makeStream(`ZinkCloud | ${detectedQuality}`, `${label} [Download]`, directUrl, detectedQuality, {}));
      }
    }

    // Also look for FSL links in buttons
    $b("a.btn").each((_: number, el: any) => {
      const link = $b(el).attr("href") || "";
      const text = $b(el).text().toLowerCase();
      if (!link) return;
      if (text.includes("fsl")) {
        const synced = `${link}1${new Date().getMinutes()}`;
        logger.info(`[${PROVIDER_NAME}] HubCloud: FSL link (${detectedQuality})`);
        streams.push(makeStream(`ZinkCloud FSL | ${detectedQuality}`, `${label} [FSL]`, synced, detectedQuality, { "Referer": bridgeUrl }));
      }
    });

    logger.info(`[${PROVIDER_NAME}] HubCloud: found ${streams.length} streams`);
    return streams;
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] HubCloud error: ${e.message}`); return []; }
}

async function resolveZinkCloud(url: string, label: string, quality: string): Promise<any[]> {
  const fileID = url.split("/").pop() || "";
  if (processedFiles.has(fileID)) return [];
  processedFiles.add(fileID);
  try {
    const domain = getOrigin(url);
    logger.info(`[${PROVIDER_NAME}] ZinkCloud: fileID=${fileID} quality=${quality}`);
    const tokenData = await fetchJson(`${domain}/ajax_generate_token.php?random_id=${fileID}`, {
      method: "POST",
      headers: { ...HEADERS, "Referer": url, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" },
      body: `random_id=${fileID}`,
    });
    if (!tokenData || tokenData.status !== "success" || !tokenData.token) {
      logger.info(`[${PROVIDER_NAME}] ZinkCloud: token failed`);
      return [];
    }
    const dlPageUrl = `${domain}/dl/${tokenData.token}`;
    logger.info(`[${PROVIDER_NAME}] ZinkCloud: fetching dl page`);
    const [workerData, dlHtml] = await Promise.all([
      fetchJson(`${domain}/server-handler.php`, {
        method: "POST",
        headers: { ...HEADERS, "Referer": dlPageUrl, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ server: "worker", random_id: fileID }),
      }),
      fetchHtml(dlPageUrl, { headers: { ...HEADERS, "Referer": url } }),
    ]);
    const streams: any[] = [];
    if (workerData && workerData.success && workerData.url) {
      // Worker URLs are served via Cloudflare Worker and don't play in Stremio — skip them.
      logger.info(`[${PROVIDER_NAME}] ZinkCloud: worker URL skipped (not playable)`);
    }
    // Resolve HubCloud mirrors from dl page
    const hubLinks: string[] = [];
    if (dlHtml) {
      dlHtml("a.btn.hubcloud").each((_: number, el: any) => {
        const href = dlHtml(el).attr("href");
        if (href) hubLinks.push(href);
      });
    }
    logger.info(`[${PROVIDER_NAME}] ZinkCloud: found ${hubLinks.length} hubcloud links on dl page`);
    if (hubLinks.length > 0) {
      const hubResults = await Promise.all(hubLinks.map((h) => resolveHubCloud(h, label, quality).catch(() => [])));
      hubResults.forEach((r) => streams.push(...(Array.isArray(r) ? r : [])));
    }
    logger.info(`[${PROVIDER_NAME}] ZinkCloud: returning ${streams.length} streams`);
    return streams;
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] ZinkCloud fatal: ${e.message}`); }
  return [];
}

async function extractFromPage(pageUrl: string, label: string, isTv: boolean, targetSeason?: number, targetEpisode?: number): Promise<any[]> {
  try {
    logger.info(`[${PROVIDER_NAME}] extractFromPage: ${pageUrl}`);
    const $ = await fetchHtml(pageUrl);
    if (!$) { logger.info(`[${PROVIDER_NAME}] extractFromPage: fetch failed`); return []; }
    const collected: { href: string; text: string; quality: string }[] = [];
    $("a.movie-simple-button, a.btn").each((_: number, el: any) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().toUpperCase();
      if (!href.startsWith("http") || text.includes("ZIP")) return;
      const quality = parseQuality(text);
      if (isTv) {
        const sMatch = text.match(/SEASON\s*0*(\d+)/i);
        const sNum = sMatch ? parseInt(sMatch[1]) : null;
        if (sNum === targetSeason || sNum === null) collected.push({ href, text, quality });
      } else {
        collected.push({ href, text, quality });
      }
    });
    logger.info(`[${PROVIDER_NAME}] extractFromPage: found ${collected.length} buttons`);
    const tasks = collected.map((btn) => () => {
      if (btn.href.includes("zinkcloud.net")) return resolveZinkCloud(btn.href, label, btn.quality);
      logger.info(`[${PROVIDER_NAME}] Skipping non-ZinkCloud link: ${btn.href.substring(0, 60)}`);
      return Promise.resolve([] as any[]);
    });
    const results: any[] = [];
    for (let i = 0; i < tasks.length; i += 3) {
      const batch = await Promise.all(tasks.slice(i, i + 3).map((fn) => fn().catch(() => [])));
      batch.forEach((r) => results.push(...(Array.isArray(r) ? r : r ? [r] : [])));
    }
    return results;
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] extractFromPage error: ${e.message}`); return []; }
}

export async function getStreams(tmdbId: string, mediaType: string, season?: number, episode?: number): Promise<any[]> {
  visitedUrls = new Set();
  processedFiles = new Set();
  try {
    const info = await getTMDBInfo(tmdbId, mediaType);
    if (!info.title) return [];
    const isTv = mediaType === "tv" || mediaType === "series";
    logger.info(`[${PROVIDER_NAME}] Request: ID=${tmdbId} Type=${mediaType} S=${season} E=${episode}`);
    const safeSeason = season != null ? Number(season) : undefined;
    const safeEpisode = episode != null ? Number(episode) : undefined;
    const embedPromise = info.imdbId ? resolveEmbed(info.imdbId, info.title, isTv, safeSeason, safeEpisode) : Promise.resolve([]);
    const searchResults = await searchSite(info.title);
    let bestMatch: { title: string; href: string; year: string | null } | null = null, bestScore = 0;
    for (const r of searchResults) {
      const score = similarity(info.title, r.title, info.year);
      if (score > bestScore) { bestScore = score; bestMatch = r; }
    }
    logger.info(`[${PROVIDER_NAME}] Best match: ${bestMatch?.title || "none"} (score=${bestScore.toFixed(2)})`);
    let pageStreams: any[] = [];
    if (bestMatch && bestScore > 0.3) pageStreams = await extractFromPage(bestMatch.href, info.title, isTv, safeSeason, safeEpisode);
    const embedStreams = await embedPromise;
    return dedupe([...embedStreams, ...pageStreams]);
  } catch (e: any) { logger.error(`[${PROVIDER_NAME}] Fatal: ${e.message}`); return []; }
}
