import { Router } from "express";
import type { Request, Response } from "express";
import axios from "axios";
import { logger } from "../lib/logger.js";

const raProxyRouter = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const GROOVY_REFERER = "https://groovy.monster/";
const GROOVY_ORIGIN = "https://groovy.monster";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(url: string, base: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

function urlDir(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    parts.pop();
    return `${u.protocol}//${u.host}${parts.join("/")}`;
  } catch { return url; }
}

/** base64url-encode an arbitrary string for safe use as a query param */
function encodeCookie(cookie: string): string {
  return Buffer.from(cookie, "utf8").toString("base64url");
}

/** Decode a base64url cookie string */
function decodeCookie(encoded: string): string {
  try { return Buffer.from(encoded, "base64url").toString("utf8"); } catch { return ""; }
}

/**
 * Build a proxy URL for a segment/sub-playlist, threading the cookie and
 * referer through so every upstream request carries authentication.
 */
function proxySegUrl(rawUrl: string, addonBase: string, referer: string, ck: string): string {
  let url = `${addonBase}/api/hls/seg?url=${encodeURIComponent(rawUrl)}&ref=${encodeURIComponent(referer)}`;
  if (ck) url += `&ck=${encodeURIComponent(ck)}`;
  return url;
}

function proxyM3u8Url(rawUrl: string, addonBase: string, referer: string, ck: string): string {
  let url = `${addonBase}/api/hls/master.m3u8?url=${encodeURIComponent(rawUrl)}&ref=${encodeURIComponent(referer)}`;
  if (ck) url += `&ck=${encodeURIComponent(ck)}`;
  return url;
}

/**
 * Rewrite every URL inside an m3u8 playlist to go through our proxy,
 * threading the cookie (ck) and referer parameters through every link so
 * that Stremio's player never has to talk to the CDN directly.
 */
function rewriteM3u8(
  content: string,
  originalUrl: string,
  addonBase: string,
  referer: string,
  ck: string
): string {
  const baseDir = urlDir(originalUrl);
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Tag lines — rewrite URI="..." attributes (keys, subtitles, etc.)
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/gi, (_match, uri: string) => {
        const abs = resolveUrl(uri, baseDir);
        const proxied = abs.includes(".m3u8")
          ? proxyM3u8Url(abs, addonBase, referer, ck)
          : proxySegUrl(abs, addonBase, referer, ck);
        return `URI="${proxied}"`;
      });
    }

    // Segment / sub-playlist lines
    const abs = resolveUrl(trimmed, baseDir);
    return abs.includes(".m3u8")
      ? proxyM3u8Url(abs, addonBase, referer, ck)
      : proxySegUrl(abs, addonBase, referer, ck);
  }).join("\n");
}

/** Derive the addon's externally-accessible base URL from the request */
function addonBaseUrl(req: Request): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || (req.headers["host"] as string | undefined) || "localhost";
  return `${proto}://${host}`;
}

/** Build upstream headers, optionally including session cookies */
function buildUpstreamHeaders(referer: string, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Referer: referer,
    Origin: GROOVY_ORIGIN,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// ─── CORS pre-flight ──────────────────────────────────────────────────────────

raProxyRouter.options("/hls/{*splat}", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.sendStatus(200);
});

// ─── Master / media playlist proxy ───────────────────────────────────────────

/**
 * GET /api/hls/master.m3u8?url=...&ref=...&ck=...
 *
 * Fetches a master or media m3u8 from the upstream CDN with full auth
 * headers (Referer, Origin, Cookie), then rewrites every URL inside to
 * go through our proxy — including the cookie token so segment requests
 * are also authenticated.
 */
raProxyRouter.get("/hls/master.m3u8", async (req: Request, res: Response) => {
  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const targetUrl = decodeURIComponent(rawUrl);
  const referer = req.query["ref"]
    ? decodeURIComponent(req.query["ref"] as string)
    : GROOVY_REFERER;
  const ckEncoded = req.query["ck"] as string | undefined ?? "";
  const cookie = ckEncoded ? decodeCookie(decodeURIComponent(ckEncoded)) : undefined;

  logger.info(
    { url: targetUrl.slice(0, 100), hasCookie: !!cookie },
    "[RareAnimeProxy] Fetching m3u8"
  );

  try {
    const upstream = await axios.get<string>(targetUrl, {
      headers: buildUpstreamHeaders(referer, cookie),
      timeout: 20000,
      responseType: "text",
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      logger.warn(
        { status: upstream.status, url: targetUrl.slice(0, 100), body: String(upstream.data).slice(0, 200) },
        "[RareAnimeProxy] m3u8 upstream returned error"
      );
      res.status(upstream.status).end();
      return;
    }

    const addonBase = addonBaseUrl(req);
    const rewritten = rewriteM3u8(upstream.data, targetUrl, addonBase, referer, ckEncoded);

    logger.info(
      { url: targetUrl.slice(0, 80), lines: rewritten.split("\n").length },
      "[RareAnimeProxy] m3u8 rewritten OK"
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.send(rewritten);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, url: targetUrl.slice(0, 100) },
      "[RareAnimeProxy] m3u8 fetch error"
    );
    res.status(502).end();
  }
});

// ─── Segment / sub-playlist proxy ────────────────────────────────────────────

/**
 * GET /api/hls/seg?url=...&ref=...&ck=...
 *
 * Proxies a single HLS resource (TS segment, AES-128 key, or sub-playlist)
 * from the upstream CDN with full auth headers. If the response is itself
 * an m3u8, it is rewritten recursively.
 */
raProxyRouter.get("/hls/seg", async (req: Request, res: Response) => {
  const rawUrl = req.query["url"] as string | undefined;
  if (!rawUrl) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  const targetUrl = decodeURIComponent(rawUrl);
  const referer = req.query["ref"]
    ? decodeURIComponent(req.query["ref"] as string)
    : GROOVY_REFERER;
  const ckEncoded = req.query["ck"] as string | undefined ?? "";
  const cookie = ckEncoded ? decodeCookie(decodeURIComponent(ckEncoded)) : undefined;

  // Detect whether this is a playlist or binary segment
  const lc = targetUrl.toLowerCase();
  const isPlaylist =
    lc.includes(".m3u8") ||
    lc.includes("/hls/") ||
    lc.includes("playlist") ||
    lc.includes("index.m3u");

  try {
    const upstream = await axios.get(targetUrl, {
      headers: buildUpstreamHeaders(referer, cookie),
      timeout: 30000,
      responseType: isPlaylist ? "text" : "stream",
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      logger.warn(
        { status: upstream.status, url: targetUrl.slice(0, 100) },
        "[RareAnimeProxy] Segment upstream returned error"
      );
      res.status(upstream.status).end();
      return;
    }

    const contentType = (upstream.headers["content-type"] as string | undefined) || "";
    res.setHeader("Access-Control-Allow-Origin", "*");

    const isM3u8Response =
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegURL") ||
      isPlaylist;

    if (isM3u8Response) {
      // Sub-playlist — rewrite URLs recursively
      const text = typeof upstream.data === "string"
        ? upstream.data
        : String(upstream.data);
      const addonBase = addonBaseUrl(req);
      const rewritten = rewriteM3u8(text, targetUrl, addonBase, referer, ckEncoded);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.send(rewritten);
    } else {
      // Binary segment — stream through directly
      if (upstream.headers["content-length"]) {
        res.setHeader("Content-Length", upstream.headers["content-length"] as string);
      }
      if (upstream.headers["content-range"]) {
        res.setHeader("Content-Range", upstream.headers["content-range"] as string);
      }
      res.setHeader("Content-Type", contentType || "video/mp2t");
      res.setHeader("Cache-Control", "public, max-age=3600");
      (upstream.data as NodeJS.ReadableStream).pipe(res);
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, url: targetUrl.slice(0, 100) },
      "[RareAnimeProxy] Segment fetch error"
    );
    res.status(502).end();
  }
});

export { encodeCookie };
export default raProxyRouter;
