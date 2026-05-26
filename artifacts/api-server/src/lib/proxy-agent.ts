import { ProxyAgent, setGlobalDispatcher, Agent } from "undici";
import type { Agent as HttpsAgent } from "https";
import https from "https";
import axios from "axios";
import { logger } from "./logger.js";

// ─── Chrome 137 TLS cipher order ─────────────────────────────────────────────
// Node.js defaults differ (TLS_AES_256 first, includes DHE, etc.)
// Cloudflare detects Node.js via JA3/JA4 fingerprint — matching Chrome's exact
// cipher ordering makes requests look like a real browser.
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",       // Chrome puts 128 first; Node puts 256 first
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
  honorCipherOrder: false,   // Chrome doesn't enforce cipher preference order
  minVersion: "TLSv1.2" as const,
  maxVersion: "TLSv1.3" as const,
  sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
};

// ─── Apply Chrome TLS to axios (uses Node https.Agent) ───────────────────────
const axiosHttpsAgent = new https.Agent(CHROME_CONNECT_OPTS) as HttpsAgent;
axios.defaults.httpsAgent = axiosHttpsAgent;
logger.info("TLS: Chrome JA3 fingerprint applied to axios");

// ─── Proxy (optional) ────────────────────────────────────────────────────────
const PROXY_URL =
  process.env["HTTPS_PROXY"] ||
  process.env["HTTP_PROXY"] ||
  process.env["https_proxy"] ||
  process.env["http_proxy"] ||
  process.env["PROXY_URL"] ||
  "";

if (PROXY_URL) {
  try {
    const agent = new ProxyAgent({
      uri: PROXY_URL,
      connect: CHROME_CONNECT_OPTS,
    });
    setGlobalDispatcher(agent);
    logger.info(
      { proxy: PROXY_URL.replace(/\/\/.*@/, "//***@") },
      "Proxy: global dispatcher set — all fetch() calls routed through proxy",
    );
  } catch (err) {
    logger.warn({ err, PROXY_URL }, "Proxy: failed to set global dispatcher, falling back to Chrome-TLS only");
    setGlobalDispatcher(new Agent({ connect: CHROME_CONNECT_OPTS }));
  }
} else {
  // No proxy — still apply Chrome TLS to all fetch() calls via global dispatcher
  setGlobalDispatcher(new Agent({ connect: CHROME_CONNECT_OPTS }));
  logger.info("TLS: Chrome JA3 fingerprint applied to global fetch dispatcher");
}

export const proxyConfigured = Boolean(PROXY_URL);
export const proxyUrl = PROXY_URL;
