import axios from "axios";
import { logger } from "../lib/logger.js";

const DAHMER_API = "https://a.111477.xyz";
const BULK_PROXY = "https://p.111477.xyz/bulk";
const TIMEOUT = 25000;
const LISTING_TTL = 60 * 60 * 1000;
const CDN_TTL = 6 * 60 * 60 * 1000;

const listingCache = new Map<string, { html: string; ts: number }>();
const cdnCache = new Map<string, { cdnUrl: string; ts: number }>();

interface ParsedLink {
  text: string;
  href: string;
  size: string | null;
}

function parseLinks(html: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  let m: RegExpExecArray | null;

  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1]!;
    const linkMatch = row.match(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1]!;
    const text = linkMatch[2]!.trim();
    if (!text || href === "../" || text === "../") continue;

    let size: string | null = null;
    const sizeCell = row.match(/<td[^>]*class=["'][^"']*size[^"']*["'][^>]*(?:data-sort=["']\d+["'][^>]*)?>([^<]+)<\/td>/i);
    if (sizeCell) {
      const cellText = sizeCell[1]!.trim();
      if (cellText && cellText !== "-") size = cellText;
    }

    links.push({ text, href, size });
  }

  if (links.length === 0) {
    const lr = /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi;
    while ((m = lr.exec(html)) !== null) {
      const href = m[1]!, text = m[2]!.trim();
      if (text && href && href !== "../" && text !== "../")
        links.push({ text, href, size: null });
    }
  }

  return links;
}

function qualityLabel(str: string): string {
  const lower = str.toLowerCase();
  const codecs: string[] = [];
  if (lower.includes("dv") || lower.includes("dolby vision")) codecs.push("DV");
  if (lower.includes("hdr10+")) codecs.push("HDR10+");
  else if (lower.includes("hdr")) codecs.push("HDR");
  if (lower.includes("remux")) codecs.push("REMUX");
  if (lower.includes("imax")) codecs.push("IMAX");
  const match = str.match(/(\d{3,4})[pP]/);
  const base = match ? `${match[1]}p` : "?p";
  return codecs.length ? `${base} | ${codecs.join(" | ")}` : base;
}

function qualityNum(str: string): number {
  const m = str.match(/(\d{3,4})[pP]/);
  return m ? parseInt(m[1]!) : 0;
}

function tags(str: string): string {
  const m = str.match(/\d{3,4}[pP]\.?(.*?)\.(mkv|mp4|avi)/i);
  return m ? m[1]!.replace(/\./g, " ").trim() : "";
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

async function fetchListing(dirUrl: string): Promise<string> {
  const cached = listingCache.get(dirUrl);
  if (cached && Date.now() - cached.ts < LISTING_TTL) {
    logger.debug({ dirUrl }, "dahmermovies: listing cache hit");
    return cached.html;
  }

  const doFetch = async () => {
    const res = await axios.get<string>(dirUrl, {
      timeout: TIMEOUT,
      headers: BROWSER_HEADERS,
    });
    return res.data;
  };

  try {
    const html = await doFetch();
    listingCache.set(dirUrl, { html, ts: Date.now() });
    return html;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      const retryAfter = parseInt(String(err.response.headers["retry-after"] ?? "5"), 10);
      logger.warn({ dirUrl, retryAfter }, "dahmermovies: 429 rate limited, retrying");
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      const html = await doFetch();
      listingCache.set(dirUrl, { html, ts: Date.now() });
      return html;
    }
    throw err;
  }
}

async function resolveCdnUrl(fileUrl: string): Promise<string> {
  const cached = cdnCache.get(fileUrl);
  if (cached && Date.now() - cached.ts < CDN_TTL) {
    return cached.cdnUrl;
  }

  try {
    const res = await axios.get(`${BULK_PROXY}?u=${encodeURIComponent(fileUrl)}`, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "identity",
        Referer: "https://a.111477.xyz/",
      },
      timeout: 8000,
    });

    const location = res.headers["location"] as string | undefined;
    if (location && location.startsWith("https://")) {
      cdnCache.set(fileUrl, { cdnUrl: location, ts: Date.now() });
      return location;
    }
  } catch (err: unknown) {
    logger.debug({ err, fileUrl }, "dahmermovies: cdn resolve failed, using original url");
  }

  return fileUrl;
}

export interface DahmerStream {
  url: string;
  name: string;
  title: string;
  behaviorHints?: { notWebReady?: boolean };
}

export async function fetchDahmerStreams(
  title: string,
  year: string | number | null,
  season: number | null,
  episode: number | null,
): Promise<DahmerStream[]> {
  try {
    let dirUrl: string;
    if (season === null) {
      const dir = `${title.replace(/:/g, "")} (${year})`;
      dirUrl = `${DAHMER_API}/movies/${encodeURIComponent(dir)}/`;
    } else {
      const show = title.replace(/:/g, " -");
      dirUrl = `${DAHMER_API}/tvs/${encodeURIComponent(show)}/Season ${season}/`;
    }

    logger.info({ dirUrl }, "dahmermovies: fetching");

    const html = await fetchListing(dirUrl);
    const links = parseLinks(html);

    let filtered: ParsedLink[];
    if (season === null) {
      filtered = links.filter((p) => /(1080p|2160p)/i.test(p.text));
    } else {
      const ss = season < 10 ? `0${season}` : `${season}`;
      const ee =
        episode !== null
          ? episode < 10
            ? `0${episode}`
            : `${episode}`
          : null;
      const pat = ee
        ? new RegExp(`S${ss}E${ee}`, "i")
        : new RegExp(`S${ss}`, "i");
      filtered = links.filter((p) => pat.test(p.text));
    }

    if (!filtered.length) return [];

    const rawResults: DahmerStream[] = filtered.map((p) => {
      let url: string;
      try {
        const resolved = new URL(p.href, dirUrl);
        url = resolved.href;
      } catch {
        const base = dirUrl.endsWith("/") ? dirUrl : dirUrl + "/";
        const rel = p.href.startsWith("/") ? p.href.slice(1) : p.href;
        url = base + rel;
      }

      const ql = qualityLabel(p.text);
      const t = tags(p.text);
      const sz = p.size ? ` [${p.size}]` : "";
      return {
        url,
        name: "DahmerMovies",
        title: `DahmerMovies — ${ql}${sz}${t ? " • " + t : ""}`,
        behaviorHints: { notWebReady: true },
      };
    });

    rawResults.sort((a, b) => qualityNum(b.title) - qualityNum(a.title));

    const results = await Promise.all(
      rawResults.map(async (s) => ({
        ...s,
        url: await resolveCdnUrl(s.url),
      })),
    );

    logger.info({ count: results.length, title }, "dahmermovies: found streams");
    return results;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("Not Found")) {
      logger.info({ title }, "dahmermovies: content not available");
    } else {
      logger.warn({ err, title }, "dahmermovies: fetch error");
    }
    return [];
  }
}
