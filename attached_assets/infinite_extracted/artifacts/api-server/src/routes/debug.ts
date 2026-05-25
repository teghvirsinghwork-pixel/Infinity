import { Router } from "express";
import { getEntries, getResolveEvents, clearEntries } from "../lib/debug-log.js";
import { PROVIDER_LIST } from "../lib/provider-config.js";

const router = Router();

router.get("/debug", (_req, res) => {
  const proxy = getEntries();
  const resolve = getResolveEvents();

  function statusColor(s: number | string) {
    if (s === "ok") return "#34d399";
    if (s === "fail") return "#f87171";
    if (s === "skip") return "#888";
    if (typeof s === "number") {
      if (s >= 500) return "#f87171";
      if (s >= 400) return "#fb923c";
      if (s === 206) return "#34d399";
      return "#60a5fa";
    }
    return "#ccc";
  }

  // Provider health — check if a provider appears in the last 20 resolve events
  const recentEvents = resolve.slice(0, 40);
  const providerEmojis: Record<string, string> = {
    animesalt: "⛩️",
    rareanime: "🌙",
    animedekho: "🇮🇳",
    netmirror: "🌐",
    dooflix: "🎬",
    moviebox: "🍿",
    hindmovies: "🎞️",
    hdhub4u: "📡",
    zinkmovies: "🎥",
  };
  const providerStatus = PROVIDER_LIST.map((p) => {
    const events = recentEvents.filter(
      (e) =>
        e.detail.toLowerCase().includes(p.replace("movies", "movie")) ||
        e.step.toLowerCase().includes(p.replace("movies", "movie")),
    );
    const hasFail = events.some((e) => e.status === "fail");
    const hasOk = events.some((e) => e.status === "ok");
    const status = hasOk ? "ok" : hasFail ? "fail" : "idle";
    return { name: p, status, emoji: providerEmojis[p] ?? "🔌" };
  });

  const providerCards = providerStatus
    .map((p) => {
      const dot = p.status === "ok" ? "#34d399" : p.status === "fail" ? "#f87171" : "#555";
      const label = p.status === "ok" ? "Healthy" : p.status === "fail" ? "Error" : "Idle";
      return `<div class="pc" style="border-color:${dot}20">
        <span class="pc-e">${p.emoji}</span>
        <span class="pc-n">${p.name}</span>
        <span class="pc-s" style="color:${dot}">${label}</span>
      </div>`;
    })
    .join("");

  const resolveRows = resolve
    .map(
      (e) => `<tr>
    <td class="id">#${e.id}</td>
    <td class="time">${e.time.slice(11, 23)}</td>
    <td class="path">${e.imdbId}</td>
    <td class="method">${e.step}</td>
    <td class="status" style="color:${statusColor(e.status)}">${e.status}</td>
    <td class="target" style="white-space:normal;word-break:break-all">${e.detail}</td>
  </tr>`,
    )
    .join("\n");

  const proxyRows = proxy
    .map((e) => {
      const shortPath = e.path.length > 55 ? e.path.slice(0, 55) + "…" : e.path;
      const shortTarget = e.targetUrl
        ? e.targetUrl.length > 65
          ? e.targetUrl.slice(0, 65) + "…"
          : e.targetUrl
        : "";
      return `<tr>
      <td class="id">#${e.id}</td>
      <td class="time">${e.time.slice(11, 23)}</td>
      <td class="method">${e.method}</td>
      <td class="path" title="${e.path}">${shortPath}</td>
      <td class="range">${e.rangeHeader ?? "—"}</td>
      <td class="target" title="${e.targetUrl ?? ""}">${shortTarget}</td>
      <td class="status" style="color:${statusColor(e.status)}">${e.status}</td>
      <td class="ct">${e.contentType ?? "—"}</td>
      <td class="bytes">${e.bytesSent != null ? e.bytesSent.toLocaleString() : "—"}</td>
      <td class="dur">${e.durationMs}ms</td>
      <td class="err" style="color:#f87171">${e.error ?? ""}</td>
    </tr>`;
    })
    .join("\n");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="refresh" content="10"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>♾️ INFINITE STREAMS — Debug</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080f;--bg2:#0d0d1a;--bg3:#111120;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --accent:#7c5cfc;--accent2:#a78bfa;--success:#22d3a0;--warn:#fb923c;--err:#f87171;
  --text:#f0eeff;--text2:#9492b8;--text3:#4a4870;
}
html{-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:'SF Mono',ui-monospace,'Cascadia Code',monospace;font-size:12px;min-height:100vh;overflow-x:auto}
a{color:var(--accent2);text-decoration:none}
a:hover{text-decoration:underline}

/* ── NAV ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:rgba(8,8,16,.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.nav-brand{display:flex;align-items:center;gap:10px}
.nav-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff}
.nav-name{font-size:14px;font-weight:800;letter-spacing:-.03em;color:var(--text);font-family:system-ui,sans-serif}
.nav-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.25);color:var(--accent2);margin-left:6px;font-weight:700}
.nav-right{display:flex;align-items:center;gap:10px}
.nav-link{font-size:11px;color:var(--text3);font-family:system-ui,sans-serif;transition:color .15s}
.nav-link:hover{color:var(--accent2)}
.refresh-tag{font-size:10px;color:var(--text3);padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.04);border:1px solid var(--border)}

/* ── MAIN ── */
.main{max-width:1800px;margin:0 auto;padding:20px}

/* ── SECTION HEADER ── */
.section-header{display:flex;align-items:center;justify-content:space-between;margin:28px 0 12px;gap:8px}
.section-title{font-size:13px;font-weight:700;color:var(--text);font-family:system-ui,sans-serif;display:flex;align-items:center;gap:8px}
.section-count{font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,92,252,.12);border:1px solid rgba(124,92,252,.2);color:var(--accent2);font-weight:700}
.clear-btn{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);color:#f87171;padding:4px 12px;border-radius:5px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;transition:background .15s}
.clear-btn:hover{background:rgba(248,113,113,.15)}

/* ── PROVIDER CARDS ── */
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:8px}
.pc{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;transition:border-color .2s}
.pc-e{font-size:20px;line-height:1}
.pc-n{font-size:11px;font-weight:700;color:var(--text);font-family:system-ui,sans-serif;text-transform:capitalize}
.pc-s{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);margin-bottom:24px}
table{width:100%;border-collapse:collapse;min-width:700px}
thead{position:sticky;top:60px}
th{background:var(--bg2);color:var(--text3);padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:5px 10px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:top;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.id{color:var(--text3);width:40px}
.time{color:var(--text3);width:90px}
.method{color:var(--accent2);width:60px;font-weight:700}
.path{color:#e0e0f0;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.range{color:var(--warn);width:100px}
.target{color:var(--text3);max-width:260px;overflow:hidden;text-overflow:ellipsis}
.status{font-weight:700;width:50px}
.ct{color:var(--text3);max-width:120px;overflow:hidden;text-overflow:ellipsis}
.bytes{color:var(--success);width:80px;text-align:right}
.dur{color:var(--text3);width:70px;text-align:right}
.err{max-width:180px;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--text3);text-align:center;padding:24px;font-style:italic}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-brand">
    <div class="nav-mark">♾</div>
    <span class="nav-name">INFINITE STREAMS</span>
    <span class="nav-badge">Debug Console</span>
  </div>
  <div class="nav-right">
    <span class="refresh-tag">Auto-refresh 10s</span>
    <a class="nav-link" href="/api/">← Back to Home</a>
  </div>
</nav>

<div class="main">

  <!-- PROVIDER HEALTH -->
  <div class="section-header">
    <div class="section-title">🔌 Provider Health</div>
    <span style="font-size:10px;color:var(--text3);font-family:system-ui">Play something in Stremio to see live status</span>
  </div>
  <div class="provider-grid">${providerCards}</div>

  <!-- STREAM RESOLUTION PIPELINE -->
  <div class="section-header">
    <div class="section-title">
      ⚡ Stream Resolution Pipeline
      <span class="section-count">${resolve.length} events</span>
    </div>
    <form method="POST" action="/api/debug/clear">
      <button class="clear-btn">🗑 Clear all logs</button>
    </form>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr><th>#</th><th>Time</th><th>IMDB / ID</th><th>Step</th><th>Status</th><th>Detail</th></tr>
      </thead>
      <tbody>
        ${resolveRows || '<tr><td colspan="6" class="empty">No resolution events yet — play something in Stremio</td></tr>'}
      </tbody>
    </table>
  </div>

  <!-- PROXY REQUESTS -->
  <div class="section-header">
    <div class="section-title">
      🌐 Proxy Requests
      <span class="section-count">${proxy.length} entries</span>
    </div>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr><th>#</th><th>Time</th><th>Method</th><th>Path</th><th>Range</th><th>Target CDN URL</th><th>Status</th><th>Content-Type</th><th>Bytes</th><th>Duration</th><th>Error</th></tr>
      </thead>
      <tbody>
        ${proxyRows || '<tr><td colspan="11" class="empty">No proxy requests yet</td></tr>'}
      </tbody>
    </table>
  </div>

</div>
</body>
</html>`);
});

router.post("/debug/clear", (_req, res) => {
  clearEntries();
  res.redirect("/api/debug");
});

export default router;
