import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { manifest, ALL_ENABLED_MASK } from "./manifest.js";
import { PROVIDER_LIST } from "./lib/provider-config.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getPublicBase(req: express.Request): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

function serveLandingPage(req: express.Request, res: express.Response) {
  const base = getPublicBase(req);
  const defaultManifestUrl = `${base}/api/manifest.json`;
  const stremioUrl = `stremio://addon-manifest?manifest=${encodeURIComponent(defaultManifestUrl)}`;

  const providers: Array<{
    key: string;
    name: string;
    emoji: string;
    color: string;
    glow: string;
    tags: string[];
    desc: string;
  }> = [
    {
      key: "animesalt",
      name: "AnimeSalt",
      emoji: "⛩️",
      color: "#e879f9",
      glow: "rgba(232,121,249,0.3)",
      tags: ["Anime", "Hindi Dub", "Eng Sub", "HLS"],
      desc: "Dedicated anime streaming with Hindi, English and Japanese multi-audio HLS streams.",
    },
    {
      key: "rareanime",
      name: "RareAnime India",
      emoji: "🌙",
      color: "#8b5cf6",
      glow: "rgba(139,92,246,0.3)",
      tags: ["Anime", "Hindi Dub", "Tamil", "HLS"],
      desc: "Hindi & Tamil dubbed anime from rareanimes.buzz and animetoonhindi.com with proxied HLS playback.",
    },
    {
      key: "animedekho",
      name: "AnimeDekho",
      emoji: "🇮🇳",
      color: "#f43f5e",
      glow: "rgba(244,63,94,0.3)",
      tags: ["Hindi Dub", "Tamil", "Telugu", "15+ Extractors"],
      desc: "Hindi, Tamil & Telugu dubbed anime with 15+ extractors — StreamWish, FileMoon, GDMirrorbot and more.",
    },
    {
      key: "netmirror",
      name: "NetMirror",
      emoji: "🌐",
      color: "#06b6d4",
      glow: "rgba(6,182,212,0.3)",
      tags: ["Netflix", "Prime", "Hotstar", "1080p"],
      desc: "1080p mirror streams from Netflix, Prime Video & Hotstar with no geo-restrictions.",
    },
    {
      key: "streamflix",
      name: "StreamFlix",
      emoji: "🎬",
      color: "#6366f1",
      glow: "rgba(99,102,241,0.3)",
      tags: ["Multi-Audio", "Multi-Lang", "TMDB", "HLS"],
      desc: "Broad multilingual streaming library matched by TMDB ID with multi-audio track support.",
    },
    {
      key: "castletv",
      name: "Castle TV",
      emoji: "🏰",
      color: "#f97316",
      glow: "rgba(249,115,22,0.3)",
      tags: ["Tamil", "Hindi", "English", "Multi-Lang"],
      desc: "Multi-language streaming with Tamil, Hindi & English content via title-matched Jaccard scoring.",
    },
    {
      key: "dahmermovies",
      name: "DahmerMovies",
      emoji: "💀",
      color: "#ef4444",
      glow: "rgba(239,68,68,0.3)",
      tags: ["1080p", "4K", "Direct Links", "Movies & TV"],
      desc: "High-quality 1080p and 4K direct file streams with strict size filtering for premium sources.",
    },
    {
      key: "moviebox",
      name: "MovieBox",
      emoji: "🍿",
      color: "#f59e0b",
      glow: "rgba(245,158,11,0.3)",
      tags: ["Multi-Audio", "Hindi", "Bengali", "English"],
      desc: "Rich multi-audio library with Original, Hindi, English, Bengali and more audio tracks.",
    },
    {
      key: "hindmovies",
      name: "HindMoviez",
      emoji: "🎞️",
      color: "#10b981",
      glow: "rgba(16,185,129,0.3)",
      tags: ["Bollywood", "Hindi Dub", "480p–4K", "Series"],
      desc: "Bollywood, Hollywood & Hindi-dubbed movies and series in 480p, 720p, 1080p & 4K.",
    },
    {
      key: "fourkdhub",
      name: "4KHDHub",
      emoji: "🔷",
      color: "#0ea5e9",
      glow: "rgba(14,165,233,0.3)",
      tags: ["4K", "1080p", "HubCloud", "Direct Files"],
      desc: "4K and 1080p direct file streams via HubCloud and HubDrive with quality filtering.",
    },
    {
      key: "hdhub4u",
      name: "HDHub4U",
      emoji: "📡",
      color: "#3b82f6",
      glow: "rgba(59,130,246,0.3)",
      tags: ["Bollywood", "IMAX", "Blu-Ray", "Own Catalog"],
      desc: "Extensive Bollywood and Hollywood archive with Blu-Ray, IMAX and WebDL sources.",
    },
    {
      key: "zinkmovies",
      name: "ZinkMovies",
      emoji: "🎥",
      color: "#00c9a7",
      glow: "rgba(0,201,167,0.3)",
      tags: ["Bollywood", "South", "Multi-Lang", "4K"],
      desc: "Bollywood, Hollywood & South Indian content with AES-encrypted embed support.",
    },
  ];

  const providerCards = providers
    .map(
      (p) => `
    <div class="provider-card" style="--clr:${p.color};--glow:${p.glow}">
      <div class="provider-card-top">
        <span class="provider-emoji">${p.emoji}</span>
        <h3 class="provider-name">${p.name}</h3>
      </div>
      <p class="provider-desc">${p.desc}</p>
      <div class="provider-tags">${p.tags.map((t) => `<span class="provider-tag">${t}</span>`).join("")}</div>
    </div>`,
    )
    .join("");

  const providerCheckboxes = providers
    .map(
      (p, i) => `
    <label class="cb-row" data-index="${i}">
      <div class="cb-left">
        <div class="cb-box" id="cb-${p.key}" data-checked="1" onclick="toggleProvider('${p.key}',${i})">
          <svg class="cb-check" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span class="cb-emoji">${p.emoji}</span>
        <div class="cb-info">
          <span class="cb-name">${p.name}</span>
          <span class="cb-tags">${p.tags.slice(0, 2).join(" · ")}</span>
        </div>
      </div>
      <div class="cb-pill" id="pill-${p.key}" style="--c:${p.color}">ON</div>
    </label>`,
    )
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="description" content="INFINITE STREAMS — 12 providers, one addon. AnimeSalt, RareAnime, AnimeDekho, NetMirror, StreamFlix, Castle TV, DahmerMovies, MovieBox, HindMoviez, 4KHDHub, HDHub4U, ZinkMovies. Install in one click."/>
<title>INFINITE STREAMS — Stremio Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..900;1,14..32,300..900&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080810;--bg2:#0d0d1a;--bg3:#111120;
  --border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.12);
  --accent:#7c5cfc;--accent2:#a78bfa;--accent3:#c4b5fd;
  --text:#f1f0ff;--text2:#9492b8;--text3:#4a4870;
  --success:#22d3a0;--r:14px;
}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;line-height:1.6;min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:rgba(124,92,252,0.4);border-radius:999px}
body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");pointer-events:none;z-index:0;opacity:0.4}
.container{max-width:1080px;margin:0 auto;padding:0 20px;position:relative;z-index:1}

/* ── NAV ── */
nav{position:sticky;top:0;z-index:200;padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;background:rgba(8,8,16,0.7);backdrop-filter:blur(24px) saturate(180%);border-bottom:1px solid var(--border)}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#fff}
.nav-name{font-size:15px;font-weight:800;letter-spacing:-0.04em;color:var(--text)}
.nav-right{display:flex;align-items:center;gap:8px}
.nav-version{font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(124,92,252,0.12);border:1px solid rgba(124,92,252,0.25);color:var(--accent2);font-weight:600}
.nav-debug{font-size:11px;padding:3px 10px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text3);font-weight:600;transition:all .15s}
.nav-debug:hover{border-color:var(--border2);color:var(--text2)}
.nav-install{display:inline-flex;align-items:center;gap:7px;padding:7px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-weight:700;transition:opacity .15s,transform .15s}
.nav-install:hover{opacity:.85;transform:translateY(-1px)}

/* ── HERO ── */
.hero{padding:100px 0 72px;text-align:center;position:relative;overflow:hidden}
.hero-glow{position:absolute;top:-120px;left:50%;transform:translateX(-50%);width:700px;height:700px;background:radial-gradient(ellipse at center,rgba(124,92,252,0.18) 0%,transparent 70%);pointer-events:none}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,0.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.015) 1px,transparent 1px);background-size:40px 40px;mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,black 0%,transparent 80%);pointer-events:none}
.hero-pill{display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 8px;border-radius:999px;background:rgba(124,92,252,0.08);border:1px solid rgba(124,92,252,0.2);font-size:12px;color:var(--accent2);font-weight:600;margin-bottom:28px}
.hero-pill-dot{width:6px;height:6px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(34,211,160,0.2);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(34,211,160,0.2)}50%{box-shadow:0 0 0 6px rgba(34,211,160,0.05)}}

/* ── LOGO / BRAND ── */
.brand-logo{width:88px;height:88px;margin:0 auto 24px;border-radius:24px;background:linear-gradient(135deg,#7c5cfc 0%,#a78bfa 50%,#c4b5fd 100%);display:flex;align-items:center;justify-content:center;font-size:40px;box-shadow:0 20px 60px rgba(124,92,252,0.45),0 0 0 1px rgba(255,255,255,0.1) inset;position:relative}
.brand-logo::after{content:'';position:absolute;inset:-2px;border-radius:26px;background:linear-gradient(135deg,rgba(124,92,252,0.4),rgba(167,139,250,0.2),transparent);z-index:-1}

h1{font-size:clamp(44px,7.5vw,82px);font-weight:900;letter-spacing:-0.05em;line-height:1;margin-bottom:20px}
.h1-line1{display:block;color:var(--text)}
.h1-line2{display:block;background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 50%,var(--accent3) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:clamp(15px,2vw,17px);color:var(--text2);max-width:500px;margin:0 auto 36px;line-height:1.75;font-weight:400}
.credit-tag{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);padding:4px 12px;border-radius:999px;border:1px solid var(--border);margin-bottom:36px}
.credit-tag a{color:var(--accent2);font-weight:700}

/* ── INSTALL BOX ── */
.install-box{max-width:620px;margin:0 auto;background:linear-gradient(135deg,rgba(124,92,252,0.08),rgba(167,139,250,0.04));border:1px solid rgba(124,92,252,0.25);border-radius:20px;padding:28px;position:relative;overflow:hidden}
.install-box::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at top,rgba(124,92,252,0.08),transparent);pointer-events:none}
.install-box-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-bottom:16px}
.install-btn-big{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:16px 24px;background:linear-gradient(135deg,var(--accent) 0%,#6d28d9 100%);color:#fff;border:none;border-radius:12px;font-size:17px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:-0.02em;box-shadow:0 8px 32px rgba(124,92,252,0.45),inset 0 1px 0 rgba(255,255,255,0.15);transition:transform .15s,box-shadow .15s;text-decoration:none;margin-bottom:14px}
.install-btn-big:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(124,92,252,0.55),inset 0 1px 0 rgba(255,255,255,0.15)}
.install-btn-big-sub{font-size:12px;font-weight:500;opacity:.7}
.install-divider{display:flex;align-items:center;gap:12px;margin-bottom:14px;color:var(--text3);font-size:12px}
.install-divider::before,.install-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.url-row{display:flex;gap:8px}
.url-input{flex:1;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:9px;padding:10px 14px;font-size:11px;font-family:'SF Mono',ui-monospace,monospace;color:var(--text2);outline:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;transition:border-color .15s}
.url-input:focus{border-color:rgba(124,92,252,0.4)}
.copy-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 14px;background:rgba(124,92,252,0.12);border:1px solid rgba(124,92,252,0.25);border-radius:9px;color:var(--accent2);font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s;font-family:inherit}
.copy-btn:hover{background:rgba(124,92,252,0.2);border-color:rgba(124,92,252,0.4)}
.copy-btn.copied{background:rgba(34,211,160,0.12);border-color:rgba(34,211,160,0.3);color:var(--success)}
.install-note{margin-top:14px;font-size:11px;color:var(--text3);text-align:center}
.install-note a{color:var(--accent2);text-decoration:underline;text-underline-offset:3px}

/* ── STATS ── */
.stats-row{display:flex;justify-content:center;gap:0;margin-top:52px;border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,0.02);overflow:hidden}
.stat{flex:1;padding:20px 16px;text-align:center;border-right:1px solid var(--border)}
.stat:last-child{border-right:none}
.stat-num{font-size:26px;font-weight:900;letter-spacing:-0.04em;color:var(--text)}
.stat-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-top:3px}

/* ── SECTION ── */
.section{padding:80px 0;position:relative;z-index:1}
.section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:var(--accent2);margin-bottom:12px}
.section-title{font-size:clamp(24px,3.5vw,36px);font-weight:800;letter-spacing:-0.03em;margin-bottom:12px}
.section-sub{font-size:15px;color:var(--text2);line-height:1.7}

/* ── STEPS ── */
.steps-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:40px}
.step-card{background:var(--bg3);border:1px solid var(--border);border-radius:16px;padding:24px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}
.step-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.step-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.step-num-big{font-size:48px;font-weight:900;letter-spacing:-0.05em;color:rgba(124,92,252,0.15);position:absolute;top:12px;right:16px;line-height:1}
.step-icon{width:40px;height:40px;border-radius:10px;background:rgba(124,92,252,0.12);border:1px solid rgba(124,92,252,0.2);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:14px}
.step-title{font-size:16px;font-weight:700;margin-bottom:6px}
.step-body{font-size:13px;color:var(--text2);line-height:1.65}
.step-code{display:inline-block;margin-top:10px;padding:6px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:7px;font-size:11px;font-family:'SF Mono',ui-monospace,monospace;color:var(--accent3)}

/* ── PROVIDERS GRID ── */
.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:40px}
.provider-card{background:var(--bg3);border:1px solid var(--border);border-radius:16px;padding:22px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s,box-shadow .2s}
.provider-card:hover{border-color:var(--clr,var(--accent));transform:translateY(-2px);box-shadow:0 8px 32px var(--glow,rgba(124,92,252,0.2))}
.provider-card-top{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.provider-emoji{font-size:28px;line-height:1}
.provider-name{font-size:17px;font-weight:700;letter-spacing:-0.02em}
.provider-desc{font-size:12.5px;color:var(--text2);line-height:1.65;margin-bottom:12px}
.provider-tags{display:flex;flex-wrap:wrap;gap:5px}
.provider-tag{padding:2px 9px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:var(--text2)}

/* ── CONFIGURE ── */
.configure-box{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:28px;margin-top:40px}
.configure-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.configure-title{font-size:18px;font-weight:700;letter-spacing:-0.02em}
.configure-sub{font-size:13px;color:var(--text2);margin-bottom:24px;line-height:1.6}
.cb-list{display:flex;flex-direction:column;gap:6px;margin-bottom:24px}
.cb-row{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);cursor:pointer;transition:border-color .15s,background .15s}
.cb-row:hover{background:rgba(124,92,252,0.06);border-color:rgba(124,92,252,0.2)}
.cb-left{display:flex;align-items:center;gap:12px}
.cb-box{width:20px;height:20px;border-radius:6px;border:2px solid rgba(124,92,252,0.4);background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;cursor:pointer}
.cb-box[data-checked="0"]{background:transparent;border-color:var(--text3)}
.cb-check{width:12px;height:12px;color:white;transition:opacity .15s}
.cb-box[data-checked="0"] .cb-check{opacity:0}
.cb-emoji{font-size:20px;line-height:1}
.cb-info{display:flex;flex-direction:column;gap:1px}
.cb-name{font-size:13px;font-weight:700}
.cb-tags{font-size:10px;color:var(--text3)}
.cb-pill{font-size:10px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(34,211,160,0.12);border:1px solid rgba(34,211,160,0.25);color:var(--success);letter-spacing:.06em;transition:all .15s}
.cb-pill.off{background:rgba(255,255,255,0.04);border-color:var(--border);color:var(--text3)}
.configure-url-wrap{background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
.configure-url-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);margin-bottom:8px}
.configure-url-row{display:flex;gap:8px}
.configure-install-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 20px;background:linear-gradient(135deg,var(--accent),#6d28d9);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:-0.02em;box-shadow:0 8px 28px rgba(124,92,252,0.4),inset 0 1px 0 rgba(255,255,255,0.15);transition:transform .15s,box-shadow .15s;text-decoration:none;margin-top:8px}
.configure-install-btn:hover{transform:translateY(-1px);box-shadow:0 10px 36px rgba(124,92,252,0.5)}
.selected-count{font-size:12px;font-weight:600;color:var(--success);padding:3px 10px;border-radius:999px;background:rgba(34,211,160,0.08);border:1px solid rgba(34,211,160,0.2)}

/* ── DEBUG LINK ── */
.debug-banner{display:flex;align-items:center;justify-content:space-between;background:rgba(124,92,252,0.06);border:1px solid rgba(124,92,252,0.15);border-radius:12px;padding:14px 18px;margin-top:40px;gap:12px}
.debug-banner-text{font-size:13px;color:var(--text2)}
.debug-banner-text strong{color:var(--text)}
.debug-link{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:rgba(124,92,252,0.12);border:1px solid rgba(124,92,252,0.25);border-radius:8px;color:var(--accent2);font-size:12px;font-weight:700;transition:all .15s;white-space:nowrap}
.debug-link:hover{background:rgba(124,92,252,0.2)}

/* ── FAQ ── */
.faq-list{margin-top:36px;display:flex;flex-direction:column;gap:1px;border-radius:14px;overflow:hidden;border:1px solid var(--border)}
.faq-item{background:var(--bg3)}
.faq-q{width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:inherit;font-size:14px;font-weight:600;padding:18px 20px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;transition:background .15s}
.faq-q:hover{background:rgba(255,255,255,0.02)}
.faq-q svg{flex-shrink:0;transition:transform .25s;color:var(--text3)}
.faq-item.open .faq-q svg{transform:rotate(45deg)}
.faq-a{max-height:0;overflow:hidden;transition:max-height .3s ease,padding .3s;font-size:13px;color:var(--text2);line-height:1.7;padding:0 20px}
.faq-item.open .faq-a{max-height:200px;padding:0 20px 18px}
.faq-divider{height:1px;background:var(--border)}

/* ── STICKY BAR ── */
.sticky-bar{position:fixed;bottom:0;left:0;right:0;z-index:300;padding:12px 20px;background:rgba(8,8,16,0.92);backdrop-filter:blur(24px);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px;transform:translateY(100%);transition:transform .35s cubic-bezier(.4,0,.2,1)}
.sticky-bar.visible{transform:translateY(0)}
.sticky-bar-left{display:flex;align-items:center;gap:12px}
.sticky-logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#fff;flex-shrink:0}
.sticky-bar-title{font-size:14px;font-weight:700}
.sticky-bar-sub{font-size:11px;color:var(--text3)}
.sticky-install{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;background:var(--accent);color:#fff;border-radius:9px;font-size:13px;font-weight:700;transition:opacity .15s;white-space:nowrap}
.sticky-install:hover{opacity:.85}
@media(max-width:480px){.sticky-bar-sub,.nav-install{display:none}}

/* ── FOOTER ── */
footer{border-top:1px solid var(--border);padding:40px 20px;position:relative;z-index:1}
.footer-inner{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.footer-logo{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.footer-mark{width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff}
.footer-name{font-size:14px;font-weight:800;letter-spacing:-0.03em}
.footer-desc{font-size:12px;color:var(--text3);max-width:480px;line-height:1.6}
.footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 20px}
.footer-links a{font-size:12px;color:var(--text3);transition:color .15s}
.footer-links a:hover{color:var(--accent2)}
.footer-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);padding:4px 12px;border-radius:999px;background:rgba(34,211,160,0.06);border:1px solid rgba(34,211,160,0.15)}
.footer-status-dot{width:5px;height:5px;border-radius:50%;background:var(--success);box-shadow:0 0 6px var(--success)}
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-logo">
    <div class="nav-logo-mark">♾</div>
    <span class="nav-name">INFINITE STREAMS</span>
  </div>
  <div class="nav-right">
    <span class="nav-version">v${manifest.version}</span>
    <a href="${base}/api/debug" class="nav-debug">🔍 Debug</a>
    <a href="${stremioUrl}" class="nav-install" id="nav-install-btn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Install
    </a>
  </div>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-glow"></div>
  <div class="hero-grid"></div>
  <div class="container">

    <div class="hero-pill">
      <span class="hero-pill-dot"></span>
      Live · 11 Providers · No P2P · No Signup
    </div>

    <div class="brand-logo">♾️</div>

    <h1>
      <span class="h1-line1">INFINITE</span>
      <span class="h1-line2">STREAMS</span>
    </h1>

    <p class="hero-sub">12 premium providers. Movies, series & anime from Bollywood, Hollywood, South Indian, Hindi/Tamil/Telugu dubs and more — all in one click.</p>

    <div class="credit-tag">
      Made with <span style="color:#f43f5e;margin:0 2px">♥</span> by <a href="https://t.me/Master_si" target="_blank">@Master_si</a>
    </div>

    <!-- INSTALL BOX -->
    <div class="install-box">
      <div class="install-box-title">Quick install — all providers enabled</div>

      <a href="${stremioUrl}" class="install-btn-big" id="install-btn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7 10 12 15 17 10" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
        <span>
          Add to Stremio
          <span class="install-btn-big-sub">— opens Stremio automatically</span>
        </span>
      </a>

      <div class="install-divider">or paste the manifest URL manually</div>

      <div class="url-row">
        <input class="url-input" id="manifest-input" type="text" value="${defaultManifestUrl}" readonly onclick="this.select()" />
        <button class="copy-btn" id="copy-btn" onclick="copyUrl()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>
          Copy
        </button>
      </div>

      <p class="install-note">
        Want to choose providers? See the <a href="#configure">configuration section</a> below &nbsp;·&nbsp;
        <a href="${defaultManifestUrl}" target="_blank">View manifest.json</a>
      </p>
    </div>

    <!-- STATS -->
    <div class="stats-row">
      <div class="stat"><div class="stat-num">11</div><div class="stat-lbl">Providers</div></div>
      <div class="stat"><div class="stat-num">18+</div><div class="stat-lbl">Catalogs</div></div>
      <div class="stat"><div class="stat-num">4K</div><div class="stat-lbl">Max Quality</div></div>
      <div class="stat"><div class="stat-num">0</div><div class="stat-lbl">Signup needed</div></div>
      <div class="stat"><div class="stat-num">∞</div><div class="stat-lbl">Free forever</div></div>
    </div>

  </div>
</section>

<!-- HOW TO INSTALL -->
<section class="section" id="how-to-install" style="background:var(--bg2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="container">
    <div class="section-label">Getting started</div>
    <h2 class="section-title">Install in 3 steps</h2>
    <p class="section-sub">Works on Windows, Mac, Linux, Android, iOS — any device that runs Stremio.</p>
    <div class="steps-grid">
      <div class="step-card">
        <div class="step-num-big">1</div>
        <div class="step-icon">📥</div>
        <div class="step-title">Click "Add to Stremio"</div>
        <p class="step-body">Hit the big button above. Stremio opens and shows a confirmation dialog. Just click <strong>Install</strong>.</p>
        <span class="step-code">Works on Desktop &amp; Android</span>
      </div>
      <div class="step-card">
        <div class="step-num-big">2</div>
        <div class="step-icon">📋</div>
        <div class="step-title">Or use manual install</div>
        <p class="step-body">Copy the manifest URL. In Stremio go to <strong>Addons → Community → Install from URL</strong>, paste it and confirm.</p>
        <span class="step-code">Works everywhere including iOS</span>
      </div>
      <div class="step-card">
        <div class="step-num-big">3</div>
        <div class="step-icon">🎬</div>
        <div class="step-title">Start watching</div>
        <p class="step-body">Search any movie, series or anime. INFINITE STREAMS queries all 12 providers in parallel and shows every available stream.</p>
        <span class="step-code">Results in seconds</span>
      </div>
    </div>
  </div>
</section>

<!-- PROVIDERS -->
<section class="section">
  <div class="container">
    <div class="section-label">What's inside</div>
    <h2 class="section-title">Nine providers, one addon</h2>
    <p class="section-sub">Each provider brings unique content. Together they cover virtually everything — movies, series, anime, Bollywood, South Indian, multi-language dubs.</p>
    <div class="providers-grid">${providerCards}</div>
  </div>
</section>

<!-- CONFIGURE -->
<section class="section" id="configure" style="background:var(--bg2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="container">
    <div class="section-label">Personalise</div>
    <h2 class="section-title">Choose your providers</h2>
    <p class="section-sub">Select exactly which providers to include. Your custom manifest URL is generated instantly — just install it in Stremio.</p>

    <div class="configure-box">
      <div class="configure-header">
        <span class="configure-title">Provider Selection</span>
        <span class="selected-count" id="sel-count">12 / 12 selected</span>
      </div>
      <p class="configure-sub">Toggle providers below. The manifest URL updates in real time. Hit "Add to Stremio" when ready.</p>

      <div class="cb-list">${providerCheckboxes}</div>

      <div class="configure-url-wrap">
        <div class="configure-url-label">Your custom manifest URL</div>
        <div class="configure-url-row">
          <input class="url-input" id="custom-manifest-input" type="text" value="${defaultManifestUrl}" readonly onclick="this.select()"/>
          <button class="copy-btn" id="custom-copy-btn" onclick="copyCustomUrl()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>
            Copy
          </button>
        </div>
      </div>

      <a href="${stremioUrl}" class="configure-install-btn" id="custom-install-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7 10 12 15 17 10" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
        Add to Stremio with selected providers
      </a>
    </div>

    <!-- DEBUG BANNER -->
    <div class="debug-banner">
      <div class="debug-banner-text">
        <strong>Debug Console</strong> — monitor provider health, extraction logs, proxy requests, failed streams and response status in real time.
      </div>
      <a href="${base}/api/debug" class="debug-link">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 5V3M12 21v-2M5 12H3M21 12h-2M6.34 6.34L4.93 4.93M19.07 19.07l-1.41-1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Open Debug Console
      </a>
    </div>
  </div>
</section>

<!-- FAQ -->
<section class="section">
  <div class="container">
    <div class="section-label">FAQ</div>
    <h2 class="section-title">Common questions</h2>

    <div class="faq-list">
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Is this addon free?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Yes, completely free. No account, no subscription, no hidden fees. Just install and stream.</div>
      </div>
      <div class="faq-divider"></div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Does it use torrents or P2P?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">No. Every stream is a direct HTTP/HLS link served from CDNs — no BitTorrent, no peer-to-peer. Clean, fast, and private.</div>
      </div>
      <div class="faq-divider"></div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          The "Add to Stremio" button didn't open Stremio — what do I do?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Copy the manifest URL and use Manual Install instead: open Stremio → Addons → My Addons → Install from URL, then paste the URL.</div>
      </div>
      <div class="faq-divider"></div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Can I select which providers to use?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">Yes! Scroll to the "Choose your providers" section above, toggle the ones you want, then install with the generated URL.</div>
      </div>
      <div class="faq-divider"></div>
      <div class="faq-item">
        <button class="faq-q" onclick="toggleFaq(this)">
          Who made this?
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="faq-a">INFINITE STREAMS is made by @Master_si. For updates and support, head to Telegram.</div>
      </div>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <div class="footer-mark">♾</div>
      <span class="footer-name">INFINITE STREAMS</span>
    </div>
    <p class="footer-desc">12 providers, zero compromise. Movies, series &amp; anime from every corner of the web. Free forever.</p>
    <div class="footer-links">
      <a href="${defaultManifestUrl}" target="_blank">manifest.json</a>
      <a href="${base}/api/debug">Debug Console</a>
      <a href="https://t.me/Master_si" target="_blank">@Master_si</a>
    </div>
    <div class="footer-status">
      <div class="footer-status-dot"></div>
      By @Master_si · v${manifest.version} · 11 Providers
    </div>
  </div>
</footer>

<!-- STICKY BAR -->
<div class="sticky-bar" id="sticky-bar">
  <div class="sticky-bar-left">
    <div class="sticky-logo">♾</div>
    <div>
      <div class="sticky-bar-title">INFINITE STREAMS</div>
      <div class="sticky-bar-sub">12 providers, one addon</div>
    </div>
  </div>
  <a href="${stremioUrl}" class="sticky-install" id="sticky-install-btn">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Add to Stremio
  </a>
</div>

<script>
const BASE = ${JSON.stringify(base)};
const PROVIDER_KEYS = ${JSON.stringify(PROVIDER_LIST)};
let mask = Array(12).fill(1);

function getMask() { return mask.join(""); }

function buildManifestUrl() {
  const m = getMask();
  if (m === "111111111111") return BASE + "/api/manifest.json";
  return BASE + "/api/" + m + "/manifest.json";
}

function buildStremioUrl() {
  const mUrl = buildManifestUrl();
  return "stremio://addon-manifest?manifest=" + encodeURIComponent(mUrl);
}

function updateUrls() {
  const mUrl = buildManifestUrl();
  const sUrl = buildStremioUrl();
  const count = mask.filter(v => v === 1).length;

  document.getElementById("custom-manifest-input").value = mUrl;
  document.getElementById("custom-install-btn").href = sUrl;

  const sc = document.getElementById("sel-count");
  sc.textContent = count + " / 12 selected";
  sc.style.color = count > 0 ? "" : "#f87171";
}

function toggleProvider(key, index) {
  mask[index] = mask[index] === 1 ? 0 : 1;
  const cb = document.getElementById("cb-" + key);
  const pill = document.getElementById("pill-" + key);
  cb.dataset.checked = String(mask[index]);
  pill.textContent = mask[index] === 1 ? "ON" : "OFF";
  pill.className = "cb-pill" + (mask[index] === 0 ? " off" : "");
  updateUrls();
}

function copyUrl() {
  const input = document.getElementById("manifest-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.classList.add("copied");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied';
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy'; }, 2000);
  });
}

function copyCustomUrl() {
  const input = document.getElementById("custom-manifest-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("custom-copy-btn");
    btn.classList.add("copied");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied';
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy'; }, 2000);
  });
}

function toggleFaq(btn) {
  const item = btn.closest(".faq-item");
  item.classList.toggle("open");
}

// Sticky bar
const hero = document.querySelector(".hero");
const stickyBar = document.getElementById("sticky-bar");
const observer = new IntersectionObserver(([e]) => {
  stickyBar.classList.toggle("visible", !e.isIntersecting);
}, { threshold: 0.1 });
observer.observe(hero);
</script>

</body>
</html>`);
}

// ── Self-hosted logo SVG ─────────────────────────────────────────────────────
// Serves the addon icon directly from this server so it always loads in
// Stremio regardless of external image-hosting availability.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7C5CFC"/>
      <stop offset="100%" stop-color="#4f3bbf"/>
    </linearGradient>
    <linearGradient id="sym" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d4c6ff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="url(#bg)"/>
  <text x="256" y="345" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"
        font-size="290" font-weight="bold" fill="url(#sym)">&#x221E;</text>
</svg>`;

app.get("/api/logo.svg", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.send(LOGO_SVG);
});

// ── Configure redirect ───────────────────────────────────────────────────────
// Stremio opens {addonBase}/configure when the user taps the gear icon.
// Redirect to the landing page's provider-selection section.
app.get("/api/configure", (_req, res) => {
  res.redirect(302, "/api/#configure");
});

// ── Landing page routes ─────────────────────────────────────────────────────
app.get("/", serveLandingPage);
app.get("/api", serveLandingPage);
app.get("/api/", serveLandingPage);

// ── API routes ──────────────────────────────────────────────────────────────
app.use("/api", router);

export default app;
