import { ProxyAgent, setGlobalDispatcher, Agent } from "undici";
import https from "https";
import type { Agent as HttpsAgent } from "https";
import axios from "axios";
import { logger } from "./logger.js";

// ─── Chrome 137 TLS cipher order ─────────────────────────────────────────────
// Node.js defaults differ (TLS_AES_256 first, includes DHE, etc.)
// Cloudflare detects Node.js via JA3/JA4 fingerprint — matching Chrome's exact
// cipher ordering makes requests look like a real browser.
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const CHROME_CONNECT_OPTS = {
  ciphers: CHROME_CIPHERS,
  honorCipherOrder: false,
  minVersion: "TLSv1.2" as const,
  maxVersion: "TLSv1.3" as const,
  sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
};

// ─── Apply Chrome TLS to axios (uses Node https.Agent) ───────────────────────
const axiosHttpsAgent = new https.Agent(CHROME_CONNECT_OPTS) as HttpsAgent;
axios.defaults.httpsAgent = axiosHttpsAgent;
logger.info("TLS: Chrome JA3 fingerprint applied to axios");

// ─── Optional HTTPS proxy ─────────────────────────────────────────────────────
const PROXY_URL =
  process.env["HTTPS_PROXY"] ||
  process.env["HTTP_PROXY"] ||
  process.env["https_proxy"] ||
  process.env["http_proxy"] ||
  process.env["PROXY_URL"] ||
  "";

if (PROXY_URL) {
  try {
    const agent = new ProxyAgent({ uri: PROXY_URL, connect: CHROME_CONNECT_OPTS });
    setGlobalDispatcher(agent);
    logger.info({ proxy: PROXY_URL.replace(/\/\/.*@/, "//***@") }, "Proxy: global dispatcher set");
  } catch (err) {
    logger.warn({ err }, "Proxy: failed to set global dispatcher, using Chrome-TLS only");
    setGlobalDispatcher(new Agent({ connect: CHROME_CONNECT_OPTS }));
  }
} else {
  setGlobalDispatcher(new Agent({ connect: CHROME_CONNECT_OPTS }));
  logger.info("TLS: Chrome JA3 fingerprint applied to global fetch dispatcher");
}

// ─── Cloudflare Worker proxy ──────────────────────────────────────────────────
// Routes requests to CF-protected domains through a Cloudflare Worker so they
// originate from Cloudflare's own IP range — bypassing CF bot detection on
// cloud datacenter IPs (AWS, GCP, etc.).
//
// How to set up (free):
//   1. https://workers.cloudflare.com → Create a new Worker
//   2. Paste the contents of  cloudflare-worker/proxy.js  into the editor
//   3. Deploy → copy the *.workers.dev URL
//   4. Set  CF_WORKER_URL=https://your-worker.workers.dev  on Render
export const cfWorkerUrl = process.env["CF_WORKER_URL"] || "";
export const cfWorkerEnabled = Boolean(cfWorkerUrl);

// Domains that are Cloudflare-protected AND blocked on cloud datacenter IPs.
// Requests to these hostnames will be routed through the CF Worker.
const CF_BLOCKED = [
  "animesalt.ac",
  "rareanimes.buzz",
  "animedekho.app",
  "zinkmovies",           // matches *.zinkmovies.biz and any mirror
  "a.111477.xyz",         // dahmermovies API
  "p.111477.xyz",         // dahmermovies bulk proxy
  "api3.aoneroom.com",    // moviebox
];

function isCfBlocked(urlStr: string): boolean {
  if (!cfWorkerEnabled) return false;
  try {
    const host = new URL(urlStr).hostname;
    return CF_BLOCKED.some((d) => host === d || host.endsWith("." + d) || host.includes(d));
  } catch {
    return false;
  }
}

if (cfWorkerEnabled) {
  // ── Intercept globalThis.fetch for all fetch()-based providers ──────────────
  const _origFetch = globalThis.fetch.bind(globalThis);

  (globalThis as Record<string, unknown>)["fetch"] = function cfRoutedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    if (isCfBlocked(urlStr)) {
      const proxyUrl = `${cfWorkerUrl}?url=${encodeURIComponent(urlStr)}`;
      const newInput =
        typeof input === "string" || input instanceof URL
          ? proxyUrl
          : new Request(proxyUrl, input as Request);
      return _origFetch(newInput, init);
    }
    return _origFetch(input, init);
  };

  // ── Intercept axios for axios-based providers (rareanime uses axios) ─────────
  axios.interceptors.request.use((config) => {
    let fullUrl: string;
    if (config.url?.startsWith("http")) {
      fullUrl = config.url;
    } else if (config.baseURL) {
      fullUrl = config.baseURL.replace(/\/$/, "") + "/" + (config.url ?? "").replace(/^\//, "");
    } else {
      return config;
    }

    if (isCfBlocked(fullUrl)) {
      return {
        ...config,
        url: `${cfWorkerUrl}?url=${encodeURIComponent(fullUrl)}`,
        baseURL: undefined,
      };
    }
    return config;
  });

  logger.info(
    { workerUrl: cfWorkerUrl, routedDomains: CF_BLOCKED },
    "CF Worker: enabled — routing blocked domains through CF Worker",
  );
} else {
  logger.warn("CF Worker: not configured — CF-protected providers will fail on cloud IPs. Set CF_WORKER_URL to fix.");
}

export const proxyConfigured = Boolean(PROXY_URL);
export const proxyUrl = PROXY_URL;
