import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { getPlayerApiResult } from "../lib/animesalt-player-cache.js";
import { logDebug } from "../lib/debug-log.js";

const router = Router();

const UPSTREAM_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

export function encodeParam(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeParam(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

async function pipeUpstream(
  targetUrl: string,
  cookie: string | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  const t0 = Date.now();

  const upstreamHeaders: Record<string, string> = {
    "user-agent": UPSTREAM_UA,
    referer: "https://api3.aoneroom.com",
    origin: "https://api3.aoneroom.com",
  };
  if (cookie) upstreamHeaders["cookie"] = cookie;

  const range = req.headers["range"];
  if (range) upstreamHeaders["range"] = range;

  const ifRange = req.headers["if-range"];
  if (ifRange) upstreamHeaders["if-range"] = String(ifRange);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, targetUrl }, "Upstream fetch failed");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: 502,
      durationMs: Date.now() - t0,
      error: msg,
    });
    res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    logger.warn({ targetUrl, status: upstream.status }, "Upstream error");
    logDebug({
      method: req.method,
      path: req.path,
      rangeHeader: range,
      targetUrl,
      status: upstream.status,
      durationMs: Date.now() - t0,
      error: `CDN returned ${upstream.status}`,
    });
    res.status(upstream.status).end();
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status);

  if (!upstream.body) {
    logDebug({
      method: req.method, path: req.path, rangeHeader: range,
      targetUrl, status: upstream.status, contentType,
      bytesSent: 0, durationMs: Date.now() - t0,
    });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let bytesSent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
      bytesSent += value.byteLength;
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "Pipe interrupted");
  }

  logDebug({
    method: req.method, path: req.path, rangeHeader: range,
    targetUrl, status: upstream.status, contentType,
    bytesSent, durationMs: Date.now() - t0,
  });

  res.end();
}

function rewriteMpd(
  mpdText: string,
  cdnBase: string,
  cookie: string | undefined,
  segProxyBase: string,
): string {
  const b = encodeParam(cdnBase);
  const c = cookie ? encodeParam(cookie) : "_";
  const baseUrl = `${segProxyBase}/${b}/${c}/`;

  const cleaned = mpdText.replace(/<BaseURL[^>]*>.*?<\/BaseURL>/gs, "");
  return cleaned.replace(/(<MPD[^>]*>)/, `$1\n<BaseURL>${baseUrl}</BaseURL>`);
}

async function handleMpd(
  req: Request,
  res: Response,
  targetUrl: string,
  cookie: string | undefined,
): Promise<void> {
  try {
    const upstreamHeaders: Record<string, string> = {
      "user-agent": UPSTREAM_UA,
      referer: "https://api3.aoneroom.com",
    };
    if (cookie) upstreamHeaders["cookie"] = cookie;

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const mpdText = await upstream.text();
    const cdnBase = targetUrl.replace(/\/[^/]*$/, "/");

    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const segProxyBase = `${proto}://${host}/api/seg`;

    const rewritten = rewriteMpd(mpdText, cdnBase, cookie, segProxyBase);

    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, targetUrl }, "MPD proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/stream.mpd", async (req, res) => {
  const { u, c } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c ? decodeParam(c) : undefined;
  await handleMpd(req, res, targetUrl, cookie);
});

router.options("/stream.mpd", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HindMoviez / GDShine range-request proxy ────────────────────────────────
// Unlike /proxy (which injects CDN-specific Referer/Origin headers for
// aoneroom.com), this endpoint uses neutral headers so GDShine and other
// HindMoviez CDNs don't reject the request.  It properly forwards the
// Range header so Stremio can stream large files (>1 GB) in chunks.
router.get("/hmproxy", async (req: Request, res: Response) => {
  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const t0 = Date.now();
  const range = req.headers["range"];

  const upstreamHeaders: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "accept": "*/*",
  };
  if (range) upstreamHeaders["range"] = range;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    logger.error({ err, targetUrl }, "HMProxy: upstream fetch failed");
    if (!res.headersSent) res.status(502).end();
    return;
  }

  if (upstream.status >= 400) {
    logger.warn({ targetUrl, status: upstream.status }, "HMProxy: upstream error");
    res.status(upstream.status).end();
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "video/mp4";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  res.setHeader("Cache-Control", "no-store");
  res.status(upstream.status);

  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  let bytesSent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
      bytesSent += value.byteLength;
    }
  } catch (err) {
    logger.warn({ err, targetUrl }, "HMProxy: pipe interrupted");
  }

  logger.info({ targetUrl, status: upstream.status, bytesSent, durationMs: Date.now() - t0 }, "HMProxy: done");
  res.end();
});

router.options("/hmproxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

router.get("/proxy", async (req, res) => {
  const { u, c } = req.query as Record<string, string | undefined>;

  if (!u) { res.status(400).json({ error: "Missing u param" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeParam(u);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid u param" });
    return;
  }

  const cookie = c ? decodeParam(c) : undefined;
  const isMpd = targetUrl.includes(".mpd") || targetUrl.includes("manifest");

  if (!isMpd) {
    try {
      await pipeUpstream(targetUrl, cookie, req, res);
    } catch (err) {
      logger.error({ err, targetUrl }, "Proxy error");
      if (!res.headersSent) res.status(502).end();
    }
    return;
  }

  await handleMpd(req, res, targetUrl, cookie);
});

router.use("/seg/:b/:c", async (req: Request, res: Response) => {
  const { b, c } = req.params as Record<string, string>;
  const filename = req.path.replace(/^\//, "");

  if (!filename) { res.status(400).end(); return; }

  let cdnBase: string;
  let cookie: string | undefined;
  try {
    cdnBase = decodeParam(b);
    new URL(cdnBase);
    cookie = c !== "_" ? decodeParam(c) : undefined;
  } catch {
    res.status(400).end();
    return;
  }

  const targetUrl = cdnBase + filename;

  try {
    await pipeUpstream(targetUrl, cookie, req, res);
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

router.options("/seg/:b/:c", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── HLS proxy (generalized — supports AnimeSalt, AnimeDekho, and any CDN) ────
// Fetches the HLS playlist with caller-supplied headers, then rewrites all
// segment / sub-playlist lines to route through this server so that the player
// never needs to know the CDN's Referer/Origin requirements.

const AS_CDN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36";
const AS_CDN_REFERER = "https://animesalt.ac/";

// Extra browser-like headers that some CDNs (Cloudflare bot-mgmt) require
// to distinguish real browsers from bots/datacenter IPs.
const AS_BROWSER_EXTRA: Record<string, string> = {
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Connection": "keep-alive",
};

// /api/m3u8?url=<enc>&referer=<enc>&origin=<enc>
// referer and origin are optional — defaults keep AnimeSalt backward-compat.
router.get("/m3u8", async (req: Request, res: Response) => {
  const { url, referer: refParam, origin: originParam } = req.query as Record<string, string | undefined>;
  if (!url) { res.status(400).json({ error: "Missing url" }); return; }

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid url" }); return;
  }

  const effectiveReferer = refParam ? decodeURIComponent(refParam) : AS_CDN_REFERER;
  let effectiveOrigin: string;
  if (originParam) {
    effectiveOrigin = decodeURIComponent(originParam);
  } else {
    try { effectiveOrigin = new URL(effectiveReferer).origin; } catch { effectiveOrigin = effectiveReferer; }
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": AS_CDN_UA,
        "Referer": effectiveReferer,
        "Origin": effectiveOrigin,
        ...AS_BROWSER_EXTRA,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) { res.status(upstream.status).end(); return; }

    const text = await upstream.text();

    const parsed = new URL(targetUrl);
    const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
    const proxyBase = `${proto}://${host}/api`;

    const toAbsUrl = (rel: string): string => {
      if (rel.startsWith("http")) return rel;
      if (rel.startsWith("/")) return parsed.origin + rel;
      return segBase + rel;
    };

    // Encode referer/origin so sub-playlists and segments carry the same headers
    const refEnc = encodeURIComponent(effectiveReferer);
    const orgEnc = encodeURIComponent(effectiveOrigin);

    const proxyUrl = (absUrl: string, isPlaylist: boolean): string =>
      isPlaylist
        ? `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`
        : `${proxyBase}/seg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;

    let nextLineIsVariant = false;
    const rewritten = text.split("\n").map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, true)}"`;
        });
      }

      // Proxy AES-128 encryption key URIs so the player fetches keys through our
      // server (same IP as the CDN token was issued to) rather than directly from
      // the CDN. Without this, FileMoon and similar CDNs return 403 for key requests
      // made from the player's IP which differs from the server's IP.
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        nextLineIsVariant = false;
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          const abs = toAbsUrl(uri);
          return `URI="${proxyUrl(abs, false)}"`;
        });
      }

      if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
        nextLineIsVariant = true;
        return line;
      }

      if (!trimmed || trimmed.startsWith("#")) return line;

      const absUrl = toAbsUrl(trimmed);
      const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
      nextLineIsVariant = false;
      return proxyUrl(absUrl, isPlaylist);
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error({ err, targetUrl }, "M3U8 proxy error");
    if (!res.headersSent) res.status(502).end();
  }
});

router.options("/m3u8", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Generalized segment proxy — serves .ts / .aac / key segments with caller-supplied headers.
// /api/seg?u=<enc>&ref=<enc>&org=<enc>
// Kept at /seg (new); the old /as-seg is aliased below for backward compatibility.
function segmentContentType(targetUrl: string, cdnType: string | null): string {
  const u = targetUrl.split("?")[0].toLowerCase();
  if (u.endsWith(".ts") || u.includes(".ts?")) return "video/MP2T";
  if (u.endsWith(".aac") || u.includes(".aac?")) return "audio/aac";
  if (u.endsWith(".mp4") || u.includes(".mp4?")) return "video/mp4";
  if (u.endsWith(".m4s") || u.includes(".m4s?")) return "video/iso.segment";
  if (u.endsWith(".vtt") || u.includes(".vtt?")) return "text/vtt";
  if (u.endsWith(".key") || u.includes(".key?")) return "application/octet-stream";
  return cdnType ?? "video/MP2T";
}

async function serveSegment(req: Request, res: Response, targetUrl: string, referer?: string, origin?: string) {
  try {
    const headers: Record<string, string> = {
      "User-Agent": AS_CDN_UA,
      ...AS_BROWSER_EXTRA,
    };
    if (referer) headers["Referer"] = referer;
    if (origin) headers["Origin"] = origin;

    const rangeHeader = req.headers["range"];
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(targetUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok && upstream.status !== 206) { res.status(upstream.status).end(); return; }

    const cdnContentType = upstream.headers.get("content-type");
    const contentType = segmentContentType(targetUrl, cdnContentType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.status(upstream.status);

    if (!upstream.body) { res.end(); return; }

    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    logger.error({ err, targetUrl }, "Segment proxy error");
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/seg", async (req: Request, res: Response) => {
  const { u, ref, org } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl, ref ? decodeURIComponent(ref) : undefined, org ? decodeURIComponent(org) : undefined);
});

router.options("/seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// Backward-compat alias for AnimeSalt segments (old /as-seg path)
router.get("/as-seg", async (req: Request, res: Response) => {
  const { u } = req.query as Record<string, string | undefined>;
  if (!u) { res.status(400).end(); return; }
  let targetUrl: string;
  try { targetUrl = decodeURIComponent(u); new URL(targetUrl); } catch { res.status(400).end(); return; }
  await serveSegment(req, res, targetUrl);
});

router.options("/as-seg", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

// ─── AnimeSalt fresh-relay ────────────────────────────────────────────────────
// Instead of embedding a pre-signed CDN URL in the stream response (which gets
// IP-checked against the server IP at FETCH time but then may be blocked by
// Cloudflare bot-mgmt on the next segment request), this endpoint:
//   1. Re-calls AnimeSalt's player API fresh on every playback start → gets a
//      brand-new signed m3u8 URL bound to OUR server IP right now.
//   2. Immediately fetches and proxies that m3u8 with full browser headers,
//      rewriting all sub-playlist / segment lines through /api/m3u8 and /api/seg.
// This makes every single CDN request originate from our server IP with the
// token that was literally just issued for that same IP seconds ago.
//
// The result is cached for 90 seconds and pre-warmed from the stream handler so
// Stremio gets an instant response instead of waiting 10-15 s for two sequential
// upstream fetches.
//
// GET /api/as-relay?hash=<videoHash>&player=<base64url-playerCdn>

interface RelayCache { m3u8: string; expiresAt: number }
const relayResultCache = new Map<string, RelayCache>();
const relayInFlight = new Map<string, Promise<string>>();
const RELAY_TTL_MS = 90_000;

async function computeRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const playerUrl = `${playerCdn}/video/${hash}`;
  const animesaltBase = "https://animesalt.ac";

  // Step 1: Get the signed m3u8 URL.
  // Check the scraper's cache first — animesalt.ts already called the player API
  // during scraping and stored the result.  If it's there we skip a full round-trip.
  let m3u8Url: string | undefined = getPlayerApiResult(hash)?.m3u8Url;

  if (m3u8Url) {
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: m3u8 from scraper cache (skip player API call)");
  } else {
    // Cache miss — call the player API fresh.
    logger.info({ hash }, "AnimeSalt relay: cache miss, calling player API");
    const apiResp = await fetch(
      `${playerCdn}/player/index.php?data=${hash}&do=getVideo`,
      {
        method: "POST",
        headers: {
          "User-Agent": AS_CDN_UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${animesaltBase}/`,
          "Origin": playerCdn,
          "X-Requested-With": "XMLHttpRequest",
          ...AS_BROWSER_EXTRA,
        },
        body: `hash=${hash}&r=${encodeURIComponent(`${animesaltBase}/`)}`,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!apiResp.ok) {
      throw Object.assign(new Error("player API error"), { status: apiResp.status });
    }

    const json = (await apiResp.json()) as Record<string, unknown>;
    m3u8Url = (
      json["videoSource"] ?? json["securedLink"] ?? json["file"] ??
      json["url"] ?? json["hls"] ?? json["src"]
    ) as string | undefined;

    if (!m3u8Url) throw new Error("no m3u8 in player API response");
    logger.info({ hash, m3u8Url: m3u8Url.slice(0, 80) }, "AnimeSalt relay: fresh m3u8 obtained via player API");
  }

  // Step 2: Fetch the master m3u8 immediately from our server (same IP, fresh token)
  const upstream = await fetch(m3u8Url, {
    headers: {
      "User-Agent": AS_CDN_UA,
      "Referer": playerUrl,
      "Origin": playerCdn,
      ...AS_BROWSER_EXTRA,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });

  if (!upstream.ok) {
    throw Object.assign(new Error("CDN m3u8 fetch failed"), { status: upstream.status });
  }

  const text = await upstream.text();
  const parsed = new URL(m3u8Url);
  const segBase = parsed.origin + parsed.pathname.replace(/[^/]+$/, "");

  const refEnc = encodeURIComponent(playerUrl);
  const orgEnc = encodeURIComponent(playerCdn);

  const toAbsUrl = (rel: string): string => {
    if (rel.startsWith("http")) return rel;
    if (rel.startsWith("/")) return parsed.origin + rel;
    return segBase + rel;
  };

  const proxyUrl = (absUrl: string, isPlaylist: boolean): string =>
    isPlaylist
      ? `${proxyBase}/m3u8?url=${encodeURIComponent(absUrl)}&referer=${refEnc}&origin=${orgEnc}`
      : `${proxyBase}/seg?u=${encodeURIComponent(absUrl)}&ref=${refEnc}&org=${orgEnc}`;

  let nextLineIsVariant = false;
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MEDIA") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), true)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
      nextLineIsVariant = false;
      return line.replace(/URI="([^"]+)"/g, (_m, uri: string) =>
        `URI="${proxyUrl(toAbsUrl(uri), false)}"`
      );
    }
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) { nextLineIsVariant = true; return line; }
    if (!trimmed || trimmed.startsWith("#")) return line;
    const absUrl = toAbsUrl(trimmed);
    const isPlaylist = nextLineIsVariant || /\.m3u8/i.test(absUrl);
    nextLineIsVariant = false;
    return proxyUrl(absUrl, isPlaylist);
  }).join("\n");
}

// Returns a promise that resolves to the rewritten m3u8, using the cache and
// in-flight dedup map to avoid redundant upstream calls.
async function getRelayM3u8(hash: string, playerCdn: string, proxyBase: string): Promise<string> {
  const key = `${hash}::${playerCdn}::${proxyBase}`;

  const cached = relayResultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.m3u8;

  const inflight = relayInFlight.get(key);
  if (inflight) return inflight;

  const promise = computeRelayM3u8(hash, playerCdn, proxyBase).then((m3u8) => {
    relayResultCache.set(key, { m3u8, expiresAt: Date.now() + RELAY_TTL_MS });
    relayInFlight.delete(key);
    return m3u8;
  }).catch((err) => {
    relayInFlight.delete(key);
    throw err;
  });

  relayInFlight.set(key, promise);
  return promise;
}

/**
 * Pre-warm the relay cache in the background so that the first playback
 * request gets a cache-hit instead of waiting 10-15 s.  Call this from the
 * stream handler right after building the relay URL.
 */
export function prewarmAsRelay(hash: string, playerCdn: string, proxyBase: string): void {
  getRelayM3u8(hash, playerCdn, proxyBase).catch(() => {});
}

router.get("/as-relay", async (req: Request, res: Response) => {
  const { hash, player } = req.query as Record<string, string | undefined>;
  if (!hash || !player) {
    res.status(400).json({ error: "Missing hash or player" });
    return;
  }

  let playerCdn: string;
  try {
    playerCdn = decodeParam(player);
    new URL(playerCdn);
  } catch {
    res.status(400).json({ error: "Invalid player param" });
    return;
  }

  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
  const proxyBase = `${proto}://${host}/api`;

  try {
    const m3u8 = await getRelayM3u8(hash, playerCdn, proxyBase);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(m3u8);
  } catch (err: unknown) {
    logger.error({ err, hash, playerCdn }, "AnimeSalt relay error");
    if (!res.headersSent) {
      const status = (err as { status?: number }).status;
      res.status(typeof status === "number" ? status : 502).end();
    }
  }
});

router.options("/as-relay", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.status(204).end();
});

export default router;
