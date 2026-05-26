import { ProxyAgent, setGlobalDispatcher, Agent } from "undici";
import { logger } from "./logger.js";

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
      connect: { rejectUnauthorized: false },
    });
    setGlobalDispatcher(agent);
    logger.info({ proxy: PROXY_URL.replace(/\/\/.*@/, "//***@") }, "Proxy: global dispatcher set — all fetch() calls routed through proxy");
  } catch (err) {
    logger.warn({ err, PROXY_URL }, "Proxy: failed to set global dispatcher, continuing without proxy");
  }
} else {
  const agent = new Agent({ connect: { keepAlive: true } });
  setGlobalDispatcher(agent);
}

export const proxyConfigured = Boolean(PROXY_URL);
export const proxyUrl = PROXY_URL;
