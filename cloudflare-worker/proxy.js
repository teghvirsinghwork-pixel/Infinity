/**
 * INFINITE STREAMS — Cloudflare Worker Proxy
 *
 * Proxies HTTP/HTTPS requests on behalf of the Render server so they
 * originate from Cloudflare's IP range (bypassing CF bot detection).
 *
 * Deploy:
 *   1. https://workers.cloudflare.com → Create a new Worker
 *   2. Paste this entire file into the editor
 *   3. Click "Deploy" → copy the *.workers.dev URL
 *   4. Set CF_WORKER_URL=<your-worker-url> in Render environment variables
 *   5. Trigger a Render redeploy
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const target = url.searchParams.get("url");

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only allow HTTPS targets
    if (!target.startsWith("https://") && !target.startsWith("http://")) {
      return new Response(JSON.stringify({ error: "Only http/https targets allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Headers to strip before forwarding (CF-injected headers the target shouldn't see)
    const SKIP_HEADERS = new Set([
      "host",
      "cf-connecting-ip",
      "cf-ipcountry",
      "cf-ray",
      "cf-visitor",
      "cdn-loop",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-real-ip",
    ]);

    const forwardHeaders = {};
    for (const [k, v] of request.headers.entries()) {
      if (!SKIP_HEADERS.has(k.toLowerCase())) {
        forwardHeaders[k] = v;
      }
    }

    const init = {
      method: request.method,
      headers: forwardHeaders,
      redirect: "follow",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    let resp;
    try {
      resp = await fetch(target, init);
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Build response headers — strip content-encoding to avoid double-decompression
    const respHeaders = new Headers(resp.headers);
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.delete("content-encoding");
    respHeaders.delete("transfer-encoding");

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  },
};
