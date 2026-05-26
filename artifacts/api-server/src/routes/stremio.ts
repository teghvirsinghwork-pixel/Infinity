import { Router, type Request, type Response, type NextFunction } from "express";
import { manifest, CATALOG_MAP } from "../manifest.js";
import { PROVIDER_LIST, maskToConfig, type ProviderKey } from "../lib/provider-config.js";
import {
  getAllCatalogItems as raGetAllCatalogItems,
  buildAtoonCatalog as raBuildAtoonCatalog,
  getEpisodeLinks as raGetEpisodeLinks,
  resolveCodedewToArgonId,
  getPageMeta as raGetPageMeta,
  getSeasonSlugs,
  discoverAllSeasons,
  buildCrossSourceMerge,
  getAtoonArchiveMeta,
  getAtoonEpisodeLinks,
  getAtoonShowSeasons,
  findAndScrapeAtoonEpisodes,
  mergedAtoonSlugs,
  rareBaseToAtoonSlug,
  getAtoonEpsForBaseSlug,
  slugFromUrl as raSlugFromUrl,
  type CatalogMeta as RACatalogMeta,
  type EpisodeLink as RAEpisodeLink,
  type SeasonEntry as RASeasonEntry,
} from "../providers/rareanime/scraper.js";
import { extractStreamFromArgon } from "../providers/rareanime/argon-extractor.js";
import { fetchNetmirrorStreams } from "../providers/netmirror.js";
import { getStreams as hindmoviezGetStreams, getCatalog as hindmoviezGetCatalog } from "../providers/hindmovies.js";
import {
  getHomepage,
  searchContent,
  getMeta,
  getStreams,
  findByMeta,
} from "../providers/hdhub4u.js";
import { getStreams as zinkmoviesStreams } from "../providers/zinkmovies.js";
import { getCastleTvImdbStreams } from "../castle-tv/handlers.js";
import { fetchDahmerStreams } from "../castle-tv/dahmermovies.js";
import { fetchStreamflixStreams } from "../castle-tv/streamflix.js";
import { getFourkdHubStreams } from "../providers/fourkdhub.js";
import { getStreams as animesaltGetStreams, getStreamsByTitle as animesaltGetStreamsByTitle } from "../providers/animesalt.js";
import { getAnimeCatalog } from "../providers/animesalt-catalog.js";
import {
  catalog as animeDekhoGetCatalog,
  search as animeDekhoSearch,
  getMeta as animeDekhoGetMeta,
  getBodyTermId,
  getVidStreamIframes,
  getTrdekhoIframes,
  getEpisodePageIframes,
  getNeoCdnStreams,
  type NeoCdnSource,
  decodeId as animeDekhoDecodeId,
} from "../providers/animedekho.js";
import { resolveExtractor, type Stream as ADStream } from "../extractors/animedekho/index.js";
import { titleSimilarityScore } from "../utils/title-score.js";
import { decodeId } from "../utils/index.js";
import {
  resolveMeta,
  resolveMetaFromTmdbId,
  type ResolvedMeta,
} from "../lib/meta-resolver.js";
import {
  searchMovieBox,
  getSubjectDetails,
  getPlayInfo,
  getExtCaptions,
  type Stream as MBStream,
} from "../lib/moviebox-api.js";
import { encodeParam, prewarmAsRelay } from "./proxy.js";
import { logger } from "../lib/logger.js";
import { logResolve } from "../lib/debug-log.js";
import {
  getStreamCache,
  setStreamCache,
  streamCacheKey,
  streamCacheStats,
  TTL_MS_DEFAULT,
} from "../lib/stream-cache.js";
import type { Stream } from "../extractors/types.js";

const router = Router();

// ─── Provider config middleware ───────────────────────────────────────────────
// Intercepts any request whose path starts with a 9-char 0/1 mask prefix,
// e.g. /111100110/stream/...
// Parses the mask, stores the enabled provider set on req, then strips the
// prefix so all existing route handlers match as normal.
interface RequestWithConfig extends Request {
  enabledProviders?: Set<ProviderKey>;
}
router.use((req: RequestWithConfig, _res: Response, next: NextFunction) => {
  const m = req.path.match(/^\/([01]{9,})(\/|$)/);
  if (m) {
    req.enabledProviders = maskToConfig(m[1]!);
    // Strip the mask prefix so downstream route handlers see the original path
    req.url = req.url.replace(`/${m[1]}`, "") || "/";
  }
  next();
});

function getEnabledProviders(req: RequestWithConfig): Set<ProviderKey> {
  return req.enabledProviders ?? new Set<ProviderKey>(PROVIDER_LIST);
}

const TMDB_API_KEY = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";

const CATALOG_CACHE = new Map<string, { data: Record<string, unknown>[]; ts: number }>();
const CATALOG_TTL = 1000 * 60 * 30;

function stremioHeaders(res: import("express").Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "max-age=3600, stale-while-revalidate=3600");
}

// ─── TMDB catalog helper ──────────────────────────────────────────────────────

async function getTMDBCatalog(type: "movie" | "series", skip = 0): Promise<Record<string, unknown>[]> {
  const cacheKey = `${type}-${skip}`;
  const cached = CATALOG_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data;

  const tmdbType = type === "series" ? "tv" : "movie";
  const page = Math.floor(skip / 20) + 1;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${tmdbType}/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`,
    );
    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    const items: Record<string, unknown>[] = (data.results ?? [])
      .map((item) => ({
        id: (item["imdb_id"] as string | undefined) || `tmdb:${item["id"]}`,
        type,
        name: (item["title"] as string | undefined) || (item["name"] as string | undefined),
        poster: item["poster_path"]
          ? `https://image.tmdb.org/t/p/w300${item["poster_path"]}`
          : undefined,
        background: item["backdrop_path"]
          ? `https://image.tmdb.org/t/p/w1280${item["backdrop_path"]}`
          : undefined,
        description: item["overview"],
        releaseInfo: ((item["release_date"] as string | undefined) ||
          (item["first_air_date"] as string | undefined) || "").split("-")[0],
        imdbRating: (item["vote_average"] as number | undefined)?.toFixed(1),
      }))
      .filter((m) => !!m.name);
    CATALOG_CACHE.set(cacheKey, { data: items, ts: Date.now() });
    return items;
  } catch (e) {
    logger.error({ err: e }, "TMDB catalog error");
    return [];
  }
}

// ─── IMDb → TMDB ID resolver ──────────────────────────────────────────────────

async function imdbToTmdbId(imdbId: string, type: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
    );
    const data = (await res.json()) as {
      movie_results?: Array<{ id: number }>;
      tv_results?: Array<{ id: number }>;
    };
    const results = type === "series" ? data.tv_results : data.movie_results;
    if (results?.[0]) return String(results[0].id);
  } catch (e) {
    logger.warn({ err: e, imdbId }, "imdbToTmdbId: failed");
  }
  return null;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

router.get("/manifest.json", (req, res) => {
  stremioHeaders(res);
  // Build a dynamic base URL so logo + configurationURL always point back to
  // this server regardless of whether it's running on Replit, Vercel, or locally.
  const domains = process.env["REPLIT_DOMAINS"];
  const base = domains
    ? `https://${domains.split(",")[0]}`
    : (() => {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
        const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
        return `${proto}://${host}`;
      })();
  res.json({
    ...manifest,
    logo: `${base}/api/logo.svg`,
    configurationURL: `${base}/api/configure`,
  });
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

router.get(
  ["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"],
  async (req, res) => {
    stremioHeaders(res);
    const { type, id } = req.params;
    const extra = req.params["extra"] as string | undefined;

    let search = "";
    let skip = 0;
    let page = 1;
    let genre = "";

    if (extra) {
      for (const part of extra.split("&")) {
        if (part.startsWith("search="))
          search = decodeURIComponent(part.replace("search=", ""));
        if (part.startsWith("skip=")) {
          skip = parseInt(part.replace("skip=", "")) || 0;
          page = Math.floor(skip / 20) + 1;
        }
        if (part.startsWith("genre="))
          genre = decodeURIComponent(part.replace("genre=", ""));
      }
    }

    const skipQuery = parseInt((req.query["skip"] as string | undefined) ?? "0") || 0;
    if (!skip && skipQuery) {
      skip = skipQuery;
      page = Math.floor(skip / 20) + 1;
    }

    logger.info({ type, id, search, page, genre }, "Stremio: catalog request");

    try {
      if (id === "infinitestreams_movies" || id === "infinitestreams_series" || id === "allinone_movies" || id === "allinone_series") {
        const metas = await getTMDBCatalog(type as "movie" | "series", skip);
        res.json({ metas });
        return;
      }

      if (id === "animesalt-anime" || id === "animesalt-anime-movies") {
        const catalogType = id === "animesalt-anime" ? "series" : "movie";
        const metas = await getAnimeCatalog(catalogType, skip, search || undefined);
        res.json({ metas });
        return;
      }

      // HindMoviez catalogs
      if (id === "hindmoviez-movies" || id === "hindmoviez-series") {
        const catalogType = id === "hindmoviez-movies" ? "movie" : "series";
        try {
          const extraMap: Record<string, string> = {};
          if (search) extraMap["search"] = search;
          if (skip) extraMap["skip"] = String(skip);
          const metas = await hindmoviezGetCatalog(catalogType, id, extraMap);
          res.json({ metas });
        } catch (e) {
          logger.error({ err: e }, "HindMoviez: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // RareAnime catalogs
      if (id === "rareanime-series" || id === "rareanime-movies") {
        try {
          let metas = (await withTimeoutRA(raGetAllCatalogItems(), 8_000)) ?? [];
          if (search.trim().length > 1) {
            const q = search.trim().toLowerCase();
            metas = metas.filter((m: RACatalogMeta) => m.name.toLowerCase().includes(q));
          }
          metas = metas.filter((m: RACatalogMeta) => m.type === type);
          const paged = metas.slice(skip, skip + 200);
          res.json({ metas: paged.map((m: RACatalogMeta) => ({ id: m.id, type: m.type, name: m.name, poster: m.poster, genres: ["Anime", "Hindi Dubbed"] })) });
        } catch (e) {
          logger.error({ err: e }, "RareAnime: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // Atoon catalogs
      if (id === "atoon-series" || id === "atoon-movies") {
        try {
          let items = (await withTimeoutRA(raBuildAtoonCatalog(), 8_000)) ?? [];
          buildCrossSourceMerge();
          if (search.trim().length > 1) {
            const q = search.trim().toLowerCase();
            items = items.filter((m) => m.name.toLowerCase().includes(q));
          }
          const filtered = items.filter((m) => m.type === type);
          const paged = filtered.slice(skip, skip + 200);
          res.json({ metas: paged.map((m) => ({ id: m.id, type: m.type, name: m.name, poster: m.poster, genres: ["Anime", "Hindi Dubbed"] })) });
        } catch (e) {
          logger.error({ err: e }, "AnimeToon: catalog error");
          res.json({ metas: [] });
        }
        return;
      }

      // AnimeDekho catalogs
      if (id === "animedekho-series" || id === "animedekho-movies") {
        const catalogType = id === "animedekho-movies" ? "movie" : "series";
        let results;
        if (search) {
          results = await animeDekhoSearch(search);
          results = results.filter((r) => r.type === catalogType);
          // Relevance filter to suppress unrelated results
          const scored = results.map((r) => ({
            r,
            score: titleSimilarityScore(search, r.title),
          }));
          results = scored
            .filter(({ score }) => score >= 0.2)
            .sort((a, b) => b.score - a.score)
            .map(({ r }) => r);
        } else {
          results = await animeDekhoGetCatalog(id, genre || undefined, skip, catalogType);
        }
        const metas = results.map((r) => {
          const m: Record<string, unknown> = {
            id: r.id,
            type: catalogType,
            name: r.title,
          };
          if (r.poster) m["poster"] = r.poster;
          if (r.background) m["background"] = r.background;
          if (r.year) m["releaseInfo"] = r.year;
          if (r.description) m["description"] = r.description;
          if (r.genres?.length) m["genres"] = r.genres;
          return m;
        });
        res.json({ metas });
        return;
      }

      const items = search
        ? await searchContent(search, page)
        : await getHomepage(CATALOG_MAP[id as keyof typeof CATALOG_MAP] ?? "", page);

      // hdhub4u-webseries declares type:"series" in manifest — enforce it on every item
      const forceType: "movie" | "series" | undefined =
        id === "hdhub4u-webseries" ? "series" : undefined;

      res.json({
        metas: items.map((item) => ({
          id: item.id,
          type: forceType ?? item.type,
          name: item.name,
          poster: item.poster,
          description: item.description,
          releaseInfo: item.releaseInfo,
        })),
      });
    } catch (e) {
      logger.error({ err: e }, "Stremio: catalog error");
      res.json({ metas: [] });
    }
  },
);

// ─── Meta ─────────────────────────────────────────────────────────────────────

router.get("/meta/:type/:id.json", async (req, res) => {
  stremioHeaders(res);
  const { type, id } = req.params;
  logger.info({ type, id }, "Stremio: meta request");

  try {
    // RareAnime / Atoon native IDs — meta
    if (id.startsWith("rareanime:")) {
      await withTimeoutRA(raGetAllCatalogItems(), 8_000);
      const baseSlug = id.replace(/^rareanime:/, "");
      const pageUrl = `https://www.rareanimes.buzz/hindi/${baseSlug}/`;
      const pageMeta = await withTimeoutRA(raGetPageMeta(pageUrl), 8_000);
      const knownSeasons = getSeasonSlugs(baseSlug);
      const seasons = await withTimeoutRA(discoverAllSeasons(baseSlug, knownSeasons), 12_000) ?? knownSeasons;
      const displayName = pageMeta?.title || baseSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const isSeries = type === "series";
      const stremioMeta: Record<string, unknown> = {
        id,
        type: isSeries ? "series" : "movie",
        name: displayName,
        poster: pageMeta?.poster || undefined,
        description: pageMeta?.description || undefined,
        genres: ["Anime", "Hindi Dubbed"],
      };
      if (isSeries && seasons.length > 0) {
        const videos: Record<string, unknown>[] = [];
        const BASE_DATE = Date.now() - 365 * 24 * 60 * 60 * 1000;
        for (const s of seasons) {
          const sPageUrl = `https://www.rareanimes.buzz/hindi/${s.slug}/`;
          const eps = await withTimeoutRA(raGetEpisodeLinks(sPageUrl), 10_000) ?? [];
          const norm = normaliseRAEpisodeNumbers(eps);
          for (const ep of norm) {
            videos.push({
              id: `${id}:${s.season}:${ep.episodeNumber}`,
              title: ep.title || `Episode ${ep.episodeNumber}`,
              season: s.season,
              episode: ep.episodeNumber,
              released: new Date(BASE_DATE + (ep.episodeNumber - 1) * 86400000).toISOString(),
            });
          }
        }
        if (videos.length > 0) stremioMeta["videos"] = videos;
      } else if (!isSeries) {
        stremioMeta["videos"] = [{ id: `${id}:1:1`, title: displayName, season: 1, episode: 1 }];
      }
      res.json({ meta: stremioMeta });
      return;
    }

    if (id.startsWith("atoon:")) {
      await withTimeoutRA(raBuildAtoonCatalog(), 8_000);
      const showSlug = id.replace(/^atoon:/, "").split(":")[0];
      const showSeasons = getAtoonShowSeasons(showSlug);
      const archiveMeta = showSeasons.length > 0 ? await withTimeoutRA(getAtoonArchiveMeta(showSeasons[0].archiveId), 8_000) : null;
      const displayName = archiveMeta?.title || showSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const isSeries = type === "series";
      const stremioMeta: Record<string, unknown> = {
        id,
        type: isSeries ? "series" : "movie",
        name: displayName,
        poster: archiveMeta?.poster || undefined,
        genres: ["Anime", "Hindi Dubbed"],
      };
      if (isSeries && showSeasons.length > 0) {
        const videos: Record<string, unknown>[] = [];
        const BASE_DATE = Date.now() - 365 * 24 * 60 * 60 * 1000;
        for (const s of showSeasons) {
          const eps = await withTimeoutRA(getAtoonEpisodeLinks(s.archiveId), 10_000) ?? [];
          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            videos.push({
              id: `atoon:${showSlug}:${s.season}:${i + 1}`,
              title: ep.title || `Episode ${i + 1}`,
              season: s.season,
              episode: i + 1,
              released: new Date(BASE_DATE + i * 86400000).toISOString(),
            });
          }
        }
        if (videos.length > 0) stremioMeta["videos"] = videos;
      }
      res.json({ meta: stremioMeta });
      return;
    }

    // AnimeDekho native IDs
    if (id.startsWith("animedekho:")) {
      const meta = await animeDekhoGetMeta(id);
      if (!meta) { res.json({ meta: null }); return; }

      // Ground-truth type: prefer URL-derived mediaType from the decoded id,
      // then meta.type, then fall back to the Stremio URL param.
      const decodedId = animeDekhoDecodeId(id);
      const authorativeType: "movie" | "series" =
        decodedId?.mediaType === 1 ? "movie" :
        decodedId?.mediaType === 2 ? "series" :
        meta.type === "series" ? "series" :
        meta.type === "movie" ? "movie" :
        (type === "series" ? "series" : "movie");

      const stremioMeta: Record<string, unknown> = {
        id: meta.id,
        type: authorativeType,
        name: meta.title,
        poster: meta.poster || undefined,
        posterShape: "poster",
        description: meta.plot || undefined,
        year: meta.year || undefined,
        background: meta.poster || undefined,
        genres: meta.genres.length ? meta.genres : undefined,
        links: meta.genres.map((g) => ({
          name: g,
          category: "Genres",
          url: `stremio:///discover//${encodeURIComponent(g)}`,
        })),
      };

      if (authorativeType === "series" && meta.episodes?.length) {
        const totalEps = meta.episodes.length;
        const BASE_DATE = Date.now() - totalEps * 7 * 24 * 60 * 60 * 1000;
        stremioMeta["videos"] = meta.episodes.map((ep, idx) => ({
          id: ep.id,
          title: ep.title || `Episode ${ep.episode}`,
          season: ep.season ?? 1,
          episode: ep.episode ?? idx + 1,
          thumbnail: ep.poster || undefined,
          released: new Date(BASE_DATE + idx * 7 * 24 * 60 * 60 * 1000).toISOString(),
          overview: ep.title || undefined,
        }));
      }

      res.json({ meta: stremioMeta });
      return;
    }

    // HDHub4U native IDs
    let metaItem;
    if (id.startsWith("hd4u:")) {
      metaItem = await getMeta(decodeId(id));
    } else if (id.startsWith("tt")) {
      const meta = await resolveMeta(id, type as "movie" | "series");
      if (meta) metaItem = await findByMeta(meta, 1);
    }

    if (!metaItem) { res.json({ meta: null }); return; }

    const stremioMeta: Record<string, unknown> = {
      id,
      type: metaItem.type,
      name: metaItem.name,
      poster: metaItem.poster,
      background: metaItem.background,
      description: metaItem.description,
      year: metaItem.year,
      genres: metaItem.genres,
    };

    if (metaItem.cast?.length) stremioMeta["cast"] = metaItem.cast;

    if (metaItem.videos?.length) {
      stremioMeta["videos"] = metaItem.videos.map((ep) => ({
        id: `${id}:${ep.season}:${ep.episode}`,
        title: ep.title,
        season: ep.season,
        episode: ep.episode,
        overview: ep.overview,
        thumbnail: ep.thumbnail,
        released: ep.released ? new Date(ep.released).toISOString() : undefined,
      }));
    }

    res.json({ meta: stremioMeta });
  } catch (e) {
    logger.error({ err: e, id }, "Stremio: meta error");
    res.json({ meta: null });
  }
});

// ─── Proxy base URL ───────────────────────────────────────────────────────────

function apiBase(req: Request): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) return `https://${domains.split(",")[0]}/api`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"];
  return `${proto}://${host}/api`;
}

// ─── HDHub4U helpers ──────────────────────────────────────────────────────────

function hd4uStreamToStremio(s: Stream): Record<string, unknown> {
  return {
    name: s.name,
    title: s.title,
    url: s.url,
    behaviorHints: {
      notWebReady: s.type === "mp4" ? false : true,
      ...(s.headers ? { proxyHeaders: { request: s.headers } } : {}),
      ...s.behaviorHints,
    },
  };
}

async function getHDHub4UStreams(
  id: string,
  type: string,
  resolvedMeta?: ResolvedMeta | null,
  season?: number,
  episode?: number,
): Promise<Record<string, unknown>[]> {
  try {
    let streams: Stream[] = [];

    if (id.startsWith("hd4u:")) {
      const parts = id.split(":");
      if (parts.length >= 3) {
        const baseId = parts.slice(0, 2).join(":");
        const s = parseInt(parts[2] ?? "1");
        const e = parseInt(parts[3] ?? "1");
        const pageUrl = decodeId(baseId);
        const meta = await getMeta(pageUrl);
        if (meta?.videos) {
          const ep = meta.videos.find((v) => v.season === s && v.episode === e);
          if (ep?.links) streams = await getStreams(pageUrl, ep.links);
        }
        if (!streams.length && meta?.links)
          streams = await getStreams(pageUrl, meta.links);
      } else {
        const pageUrl = decodeId(id);
        const meta = await getMeta(pageUrl);
        if (meta?.links) streams = await getStreams(pageUrl, meta.links);
      }
      return streams.map(hd4uStreamToStremio);
    }

    const meta = resolvedMeta ?? (await resolveMeta(id, type as "movie" | "series"));
    if (!meta) { logger.warn({ id }, "HDHub4U: meta resolution failed"); return []; }

    const targetSeason = season ?? 1;
    const targetEpisode = episode ?? 1;

    logger.info({ imdbId: meta.imdbId, title: meta.title, season: targetSeason, episode: targetEpisode }, "HDHub4U: resolving");

    const metaItem = await findByMeta(meta, targetSeason);
    if (!metaItem) { logger.warn({ imdbId: meta.imdbId }, "HDHub4U: no matching page"); return []; }

    if (metaItem.type === "series" && metaItem.videos?.length) {
      let ep = metaItem.videos.find((v) => v.season === targetSeason && v.episode === targetEpisode);
      if (!ep) ep = metaItem.videos.find((v) => v.episode === targetEpisode);
      if (ep?.links?.length) {
        streams = await getStreams(metaItem.id, ep.links);
      } else if (metaItem.links?.length) {
        streams = await getStreams(metaItem.id, metaItem.links);
      }
    } else if (metaItem.links?.length) {
      streams = await getStreams(metaItem.id, metaItem.links);
    }

    logger.info({ imdbId: meta.imdbId, matchedTitle: metaItem.name, count: streams.length }, "HDHub4U: done");
    return streams.map(hd4uStreamToStremio);
  } catch (err) {
    logger.error({ err, id }, "HDHub4U: provider error");
    return [];
  }
}

// ─── ZinkMovies helpers ───────────────────────────────────────────────────────

async function getZinkMoviesStreams(
  imdbId: string,
  type: string,
  season?: number,
  episode?: number,
): Promise<Record<string, unknown>[]> {
  try {
    const mediaType = type === "series" ? "tv" : "movie";
    return await zinkmoviesStreams(imdbId, mediaType, season, episode);
  } catch (err) {
    logger.error({ err, imdbId }, "ZinkMovies: provider error");
    return [];
  }
}

async function getAnimeSaltStreams(
  imdbId: string,
  type: string,
  season?: number,
  episode?: number,
  req?: Request,
): Promise<Record<string, unknown>[]> {
  try {
    const mediaType = type === "series" ? "series" : "movie";
    const streams = await animesaltGetStreams(imdbId, mediaType, season, episode);
    if (!streams.length) return [];
    const base = req ? apiBase(req) : "";
    return streams.map((s) => {
      if (!base) return { name: s.name, title: s.title, url: s.url, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };

      // Preferred path: use the fresh-relay endpoint.
      // /api/as-relay re-calls the AnimeSalt player API fresh on every playback
      // start so the signed CDN token is always brand-new and bound to our
      // server IP.  It then immediately fetches and proxies the m3u8 from the
      // same IP, bypassing the timing window where the old approach could fail.
      if (s.hash && s.playerCdn) {
        const relayUrl = `${base}/as-relay?hash=${encodeURIComponent(s.hash)}&player=${encodeParam(s.playerCdn)}`;
        // Kick off relay computation in the background immediately so the cache
        // is hot by the time Stremio actually calls the relay URL (~1-3 s later).
        prewarmAsRelay(s.hash, s.playerCdn, base);
        return { name: s.name, title: s.title, url: relayUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
      }

      // Fallback: direct proxied m3u8 (used when hash wasn't extracted, e.g.
      // page-scrape fallback path in animesalt.ts).
      const proxiedUrl = `${base}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}&origin=${encodeURIComponent(s.origin)}`;
      return { name: s.name, title: s.title, url: proxiedUrl, subtitles: s.subtitles, behaviorHints: { notWebReady: true } };
    });
  } catch (err) {
    logger.error({ err, imdbId }, "AnimeSalt: provider error");
    return [];
  }
}

// ─── Castle TV / DahmerMovies / StreamFlix helpers ───────────────────────────

async function getCastleTvStreams(
  imdbId: string,
  type: string,
  title: string,
  year: number | undefined,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  try {
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await getCastleTvImdbStreams(type, imdbId, title, year, s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, imdbId }, "CastleTV: provider error");
    return [];
  }
}

async function getDahmerMoviesStreams(
  title: string,
  year: number | undefined,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  try {
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await fetchDahmerStreams(title, year ?? null, s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, title }, "DahmerMovies: provider error");
    return [];
  }
}

async function getStreamflixStreams(
  tmdbId: string | null,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  if (!tmdbId) return [];
  try {
    const numTmdbId = parseInt(tmdbId, 10);
    if (Number.isNaN(numTmdbId)) return [];
    const s = type === "series" ? season : null;
    const e = type === "series" ? episode : null;
    const streams = await fetchStreamflixStreams(numTmdbId, type as "movie" | "series", s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, tmdbId }, "StreamFlix: provider error");
    return [];
  }
}

async function get4KHDHubStreams(
  title: string,
  year: number | undefined,
  type: string,
  season: number,
  episode: number,
): Promise<Record<string, unknown>[]> {
  try {
    const s = type === "series" ? season : undefined;
    const e = type === "series" ? episode : undefined;
    const streams = await getFourkdHubStreams(title, year, type, s, e);
    return streams as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.error({ err, title }, "4KHDHub: provider error");
    return [];
  }
}

// ─── AnimeDekho stream helpers ────────────────────────────────────────────────

const AD_REFERER = "https://animedekho.app/";

function adEnsurePlayable(stream: ADStream): ADStream {
  const existingReferer =
    stream.behaviorHints?.proxyHeaders?.request?.["Referer"] ||
    AD_REFERER;
  let existingOrigin = AD_REFERER;
  try { existingOrigin = new URL(existingReferer).origin; } catch {}
  return {
    ...stream,
    behaviorHints: {
      ...stream.behaviorHints,
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: existingReferer,
          Origin: existingOrigin,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      },
    },
  };
}

// CDN hostnames that block all datacenter/cloud IPs at the TCP/HTTP level.
// These cannot be proxied through our server at all; the user's device must
// fetch directly. All other CDNs (StreamRuby, StreamWish, FileMoon, etc.) may
// embed our server IP in their signed tokens — those MUST go through our proxy.
const DIRECT_CDN_HOSTS = [
  "cdn-centaurus.com",
  "centaurus.com",
];

function isDirectCdn(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return DIRECT_CDN_HOSTS.some(h => host.endsWith(h));
  } catch { return false; }
}

const AD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function adStreamToStremio(s: ADStream, req?: Request): Record<string, unknown> {
  const isHls = s.type === "hls" || s.url.includes(".m3u8");
  const base = req ? apiBase(req) : "";

  if (isHls) {
    const referer =
      s.behaviorHints?.proxyHeaders?.request?.["Referer"] ||
      s.behaviorHints?.headers?.["Referer"] ||
      AD_REFERER;
    let origin = referer;
    try { origin = new URL(referer).origin; } catch {}

    // Specific CDNs that flat-out block datacenter IPs: serve directly with
    // proxyHeaders so Stremio's player adds the required Referer/Origin.
    const adSubs = s.subtitles?.length ? s.subtitles : undefined;

    if (isDirectCdn(s.url)) {
      return {
        name: s.name,
        title: s.title,
        url: s.url,
        subtitles: adSubs,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: { request: { Referer: referer, Origin: origin, "User-Agent": AD_UA } },
        },
      };
    }

    // All other CDNs (StreamRuby, StreamWish, FileMoon, as-cdn*.top, etc.):
    // route through our server proxy.  Many of these embed our server's IP in
    // the signed token (e.g. StreamRuby's `i=34.93` param).  A request from
    // any other IP is rejected 403.  The proxy also correctly handles
    // AES-128 key requests via /api/seg with the right Referer/Origin.
    if (base) {
      const proxiedUrl = `${base}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
      return {
        name: s.name,
        title: s.title,
        url: proxiedUrl,
        subtitles: adSubs,
        behaviorHints: { notWebReady: true },
      };
    }
  }

  // Non-HLS (MP4, etc.) — pass through with original headers
  return {
    name: s.name,
    title: s.title,
    url: s.url,
    type: s.type,
    subtitles: s.subtitles?.length ? s.subtitles : undefined,
    behaviorHints: s.behaviorHints,
  };
}

// ─── HindMoviez proxy wrapper ─────────────────────────────────────────────────
// GDShine streams come via Cloudflare Worker URLs (*.workers.dev).
// Cloudflare Workers have a hard 1 GB response-body limit, so any file
// larger than 1 GB stalls the player immediately.  Routing the URL
// through our /api/proxy endpoint fixes this because:
//   1. Our Node.js proxy forwards the HTTP Range header so the player can
//      fetch the file in chunks without having to buffer the whole thing.
//   2. Range requests are small (a few MB each), so no single response
//      ever hits the Cloudflare 1 GB ceiling.
// We also proxy any other HindMoviez direct-download URLs to ensure
// consistent range-request behaviour regardless of file size.
function proxyHindMoviezStreams(
  streams: import("../providers/hindmovies.js").StremioStream[],
  req: Request,
): Record<string, unknown>[] {
  const base = apiBase(req);
  return streams.map((s) => {
    const isHls = s.url.includes(".m3u8");
    if (isHls) {
      return {
        name: s.name,
        title: s.title,
        url: s.url,
        behaviorHints: { notWebReady: true },
      };
    }
    const proxiedUrl = `${base}/hmproxy?u=${encodeParam(s.url)}`;
    return {
      name: s.name,
      title: s.title,
      url: proxiedUrl,
      behaviorHints: { notWebReady: false },
    };
  });
}

function neoCdnSourceToStream(src: NeoCdnSource): ADStream {
  return {
    name: "AnimeDekho",
    title: `🎬 NeoCDN ${src.type} [${src.size}]`,
    url: src.url,
    type: "url",
    behaviorHints: { notWebReady: false },
  };
}

async function collectAnimeDekhoEpisodeStreams(
  episodeUrl: string,
): Promise<ADStream[]> {
  const [vidIframes, extraIframes, bodyInfo] = await Promise.all([
    getVidStreamIframes(episodeUrl),
    getEpisodePageIframes(episodeUrl),
    getBodyTermId(episodeUrl),
  ]);

  // Fetch trdekho iframes first — we need to inspect them to decide whether
  // NeoCDN is appropriate for this episode (Season 9 fingerprint check).
  const trdekhoIframes = bodyInfo
    ? await getTrdekhoIframes(bodyInfo.term, bodyInfo.mediaType)
    : [];

  // NeoCDN (myth player) returns sources for ANY episode term, including seasons
  // that don't actually have NeoCDN on the website (wrong/unrelated content).
  // Season 9 episodes are distinguishable by trdekho=2 pointing to gdmirrorbot.nl.
  // Only enable NeoCDN when we see that fingerprint.
  const hasGDMirrorbot = trdekhoIframes.some((u) => u.includes("gdmirrorbot.nl"));
  const neoCdnSources = (bodyInfo && hasGDMirrorbot)
    ? await getNeoCdnStreams(bodyInfo.term, bodyInfo.mediaType, episodeUrl)
    : [];

  const allIframes = [...new Set([...vidIframes, ...extraIframes, ...trdekhoIframes])];
  logger.info(
    { count: allIframes.length, neoCdn: neoCdnSources.length, hasGDMirrorbot, episodeUrl },
    "AnimeDekho: resolving iframes",
  );
  const results = await Promise.allSettled(
    allIframes.map((u) => resolveExtractor(u, episodeUrl))
  );
  // MirrorBot / GDMirrorbot streams come first; NeoCDN appended as fallback
  const streams: ADStream[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const s of r.value) streams.push(adEnsurePlayable(s));
    }
  }
  for (const src of neoCdnSources) streams.push(neoCdnSourceToStream(src));
  return streams;
}

async function collectAnimeDekhoPageStreams(pageUrl: string): Promise<ADStream[]> {
  const bodyInfo = await getBodyTermId(pageUrl);
  if (!bodyInfo) return [];

  // Same fingerprint check: fetch trdekho iframes first, then decide on NeoCDN.
  const iframes = await getTrdekhoIframes(bodyInfo.term, bodyInfo.mediaType);
  const hasGDMirrorbot = iframes.some((u) => u.includes("gdmirrorbot.nl"));
  const neoCdnSources = hasGDMirrorbot
    ? await getNeoCdnStreams(bodyInfo.term, bodyInfo.mediaType, pageUrl)
    : [];

  const results = await Promise.allSettled(iframes.map((u) => resolveExtractor(u, pageUrl)));
  const streams: ADStream[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const s of r.value) streams.push(adEnsurePlayable(s));
    }
  }
  for (const src of neoCdnSources) streams.push(neoCdnSourceToStream(src));
  return streams;
}

function isEpisodeUrl(url: string): boolean {
  return url.includes("/epi/") || /[-/]\d+x\d+\/?(?:[?#]|$)/.test(url);
}

function buildTitleVariants(title: string): string[] {
  const words = title.trim().split(/\s+/);
  // "Shin Chan" → "Shinchan" (collapsed) — handles anime/Bollywood one-word spellings
  const collapsed = title.replace(/[-\s]+/g, "").trim();
  // "Shin-chan" → "Shin chan" (hyphen→space)
  const hyphenToSpace = title.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  // "Crayon Shin-chan" → "Shin-chan" (drop first word, only if title has 3+ words)
  const dropFirst = words.length >= 3 ? words.slice(1).join(" ") : "";
  // "Shin-chan: Me and the Professor" → "Shin-chan"
  const beforeColon = title.split(":")[0]!.trim();
  // Only include single-word variants if the collapsed form equals them (avoid noise like "Chan")
  const candidates = [title, collapsed, hyphenToSpace, dropFirst, beforeColon];
  return [...new Set(candidates)].filter((v) => v && v.length > 2);
}

async function getAnimeDekhoStreams(
  title: string,
  type: string,
  season: number,
  episode: number,
): Promise<ADStream[]> {
  logger.info({ title, type, season, episode }, "AnimeDekho: title-based stream lookup");
  try {
    const targetType = type === "movie" ? "movie" : "series";
    const variants = buildTitleVariants(title);
    let bestPool: Awaited<ReturnType<typeof animeDekhoSearch>> = [];

    for (const variant of variants) {
      const results = await animeDekhoSearch(variant);
      if (!results.length) continue;
      const typed = results.filter((r) => r.type === targetType);
      if (typed.length > 0) {
        bestPool = typed;
        break;
      }
    }
    if (!bestPool.length) return [];

    const scored = bestPool
      .map((r) => ({ r, score: titleSimilarityScore(title, r.title) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    // Threshold 0.45: spinoffs score below this due to length penalty.
    // Collapsed-form matching (e.g. "Shin Chan" ↔ "Shinchan") returns 0.96,
    // so same-title one-word/two-word variants still pass.
    if (!best || best.score < 0.45) {
      logger.warn({ title, score: best?.score }, "AnimeDekho: no close title match");
      return [];
    }

    const match = best.r;
    logger.info({ title, matched: match.title, score: best.score }, "AnimeDekho: matched");

    if (targetType === "series") {
      const meta = await animeDekhoGetMeta(match.id);
      if (!meta?.episodes?.length) return [];

      // 1. Exact match
      let ep = meta.episodes.find((e) => e.season === season && e.episode === episode);

      // 2. Some AnimeDekho series list all eps under season=1 regardless of actual season
      //    Try matching just by episode number within the whole list
      if (!ep) {
        ep = meta.episodes.find((e) => e.episode === episode);
        if (ep) logger.warn({ title, season, episode, foundSeason: ep.season }, "AnimeDekho: season mismatch, matched by episode number only");
      }

      // 3. Linear position fallback — treat the whole ep list as a flat ordered array
      //    Episode = (season-1)*maxEpPerSeason + episode, but simpler: index = episode-1
      if (!ep) {
        const idx = episode - 1;
        if (idx >= 0 && idx < meta.episodes.length) {
          ep = meta.episodes[idx];
          if (ep) logger.warn({ title, season, episode, idx }, "AnimeDekho: fell back to linear episode index");
        }
      }

      if (!ep) {
        logger.warn({ title, season, episode, totalEps: meta.episodes.length }, "AnimeDekho: episode not found in meta");
        return [];
      }
      return collectAnimeDekhoEpisodeStreams(ep.url);
    } else {
      return collectAnimeDekhoPageStreams(match.url);
    }
  } catch (err) {
    logger.error({ title, err }, "AnimeDekho: getAnimeDekhoStreams error");
    return [];
  }
}

async function getAnimeDekhoNativeStreams(
  stremioId: string,
  type: string,
  season: number,
  episode: number,
): Promise<ADStream[]> {
  logger.info({ stremioId, type, season, episode }, "AnimeDekho: native ID stream");
  try {
    const decoded = animeDekhoDecodeId(stremioId);
    if (!decoded) return [];

    // Use decoded.mediaType (from the encoded ID) as ground truth.
    // Stremio's `type` URL param can be wrong if getMeta previously mis-classified the content.
    // Also treat explicit episode URLs as series regardless of type param.
    const isEpUrl = isEpisodeUrl(decoded.url);
    const effectiveType: "movie" | "series" =
      isEpUrl ? "series" :
      decoded.mediaType === 1 ? "movie" :
      decoded.mediaType === 2 ? "series" :
      (type === "series" ? "series" : "movie");

    logger.info({ stremioId, type, effectiveType, decodedMediaType: decoded.mediaType, isEpUrl }, "AnimeDekho: effective type resolved");

    if (effectiveType === "series") {
      // Direct episode URL → stream it immediately
      if (isEpUrl) {
        return collectAnimeDekhoEpisodeStreams(decoded.url);
      }
      // Series index page → look up episode list and find the right episode
      const meta = await animeDekhoGetMeta(stremioId);
      if (!meta?.episodes?.length) {
        logger.warn({ stremioId, season, episode }, "AnimeDekho: series has no episodes in meta");
        return [];
      }

      // 1. Exact season + episode match
      let ep = meta.episodes.find((e) => e.season === season && e.episode === episode);

      // 2. Episode number only (AnimeDekho sometimes lists all eps as season 1)
      if (!ep) {
        ep = meta.episodes.find((e) => e.episode === episode);
        if (ep) logger.warn({ stremioId, season, episode, foundSeason: ep.season }, "AnimeDekho: native season mismatch, matched by ep num");
      }

      // 3. Linear index fallback
      if (!ep) {
        const idx = episode - 1;
        if (idx >= 0 && idx < meta.episodes.length) {
          ep = meta.episodes[idx];
          if (ep) logger.warn({ stremioId, season, episode, idx }, "AnimeDekho: native fell back to linear ep index");
        }
      }

      if (!ep) {
        logger.warn({ stremioId, season, episode, total: meta.episodes.length }, "AnimeDekho: native episode not found");
        return [];
      }
      return collectAnimeDekhoEpisodeStreams(ep.url);
    } else {
      return collectAnimeDekhoPageStreams(decoded.url);
    }
  } catch (err) {
    logger.error({ stremioId, err }, "AnimeDekho: native stream error");
    return [];
  }
}

// ─── MovieBox helpers ─────────────────────────────────────────────────────────

function detectStreamType(url: string, format: string) {
  if (url.startsWith("magnet:") || url.endsWith(".torrent")) return "skip";
  if (url.includes(".mpd")) return "dash";
  if (format.toUpperCase() === "HLS" || url.includes(".m3u8")) return "hls";
  if (url.includes(".mp4") || url.includes(".mkv")) return "mp4";
  return "unknown";
}

function mbQualityLabel(resolutions: string): string {
  for (const q of ["2160", "1440", "1080", "720", "480", "360", "240"]) {
    if (resolutions.includes(q)) return `${q}p`;
  }
  return resolutions || "HD";
}

function mbStreamToStremio(
  stream: MBStream,
  language: string,
  req: Request,
  subtitles?: Array<{ url: string; lang: string }>,
): Record<string, unknown> | null {
  if (!stream.url) return null;
  const sType = detectStreamType(stream.url, stream.format);
  if (sType === "skip") return null;

  const qLabel = mbQualityLabel(stream.resolutions);
  const langLabel = language.replace(/dub/i, "Audio");
  const base = apiBase(req);
  const params = `u=${encodeParam(stream.url)}` + (stream.signCookie ? `&c=${encodeParam(stream.signCookie)}` : "");

  const proxyUrl = sType === "dash"
    ? `${base}/stream.mpd?${params}`
    : `${base}/proxy?${params}`;

  const stremioSubs = (subtitles ?? []).map((s) => ({
    url: s.url,
    lang: s.lang,
    id: s.lang,
  }));

  return {
    name: "MovieBox",
    title: `${qLabel} · ${langLabel}`,
    url: proxyUrl,
    subtitles: stremioSubs,
    behaviorHints: { notWebReady: false },
  };
}

function titleVariants(title: string): string[] {
  const variants: string[] = [title];
  const t = title.trim();
  const noArticle = t.replace(/^(the|a|an)\s+/i, "");
  if (noArticle !== t) variants.push(noArticle);
  const noSubtitle = t.replace(/\s*[:\-–]\s+.+$/, "");
  if (noSubtitle !== t && noSubtitle.length > 2) variants.push(noSubtitle);
  const noSubNoArt = noSubtitle.replace(/^(the|a|an)\s+/i, "");
  if (noSubNoArt !== noSubtitle && noSubNoArt !== noArticle && noSubNoArt.length > 2)
    variants.push(noSubNoArt);
  const words = t.split(/\s+/);
  if (words.length > 3) variants.push(words.slice(0, 3).join(" "));
  return [...new Set(variants)];
}

async function resolveSubjectId(
  title: string,
  year: number | undefined,
  isSeries: boolean,
  logKey: string,
): Promise<string | null> {
  const targetType = isSeries ? 2 : 1;
  for (const query of titleVariants(title)) {
    const results = await searchMovieBox(query);
    if (!results.length) continue;

    const scored = results.map((r) => {
      let score = 0;
      const rTitle = r.title.toLowerCase().trim();
      const qTitle = title.toLowerCase().trim();
      const qQuery = query.toLowerCase().trim();
      if (rTitle === qTitle) score += 60;
      else if (rTitle === qQuery) score += 50;
      else if (rTitle.includes(qTitle) || qTitle.includes(rTitle)) score += 25;
      else if (rTitle.includes(qQuery) || qQuery.includes(rTitle)) score += 15;
      if (r.subjectType === targetType) score += 15;
      if (year && r.imdbRating) score += 2;
      return { ...r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.score >= 10) {
      logResolve({ imdbId: logKey, step: "moviebox-search", status: "ok", detail: `"${best.title}" id=${best.subjectId} score=${best.score} query="${query}"` });
      return best.subjectId;
    }
  }

  logResolve({ imdbId: logKey, step: "moviebox-search", status: "fail", detail: `No match for "${title}" after ${titleVariants(title).length} variants` });
  return null;
}

async function fetchMovieBoxById(
  subjectId: string,
  season: number,
  episode: number,
  req: Request,
  logKey: string,
): Promise<Record<string, unknown>[]> {
  const { token, dubs } = await getSubjectDetails(subjectId);
  logResolve({ imdbId: logKey, step: "subject-details", status: "ok", detail: `token=${!!token} dubs=${dubs.map((d) => d.lanName).join(",") || "none"}` });

  const allSubjects = [
    { subjectId, language: "Original" },
    ...dubs.map((d) => ({ subjectId: d.subjectId, language: d.lanName })),
  ];

  const results: Record<string, unknown>[] = [];
  for (const { subjectId: sid, language } of allSubjects) {
    const streams = await getPlayInfo(sid, season, episode, token);
    logResolve({ imdbId: logKey, step: "play-info", status: streams.length ? "ok" : "fail", detail: `lang=${language} streams=${streams.length}` });

    // Fetch captions in parallel for all streams in this language track
    const captionResults = await Promise.allSettled(
      streams.map((stream) => getExtCaptions(sid, stream.id, token))
    );

    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i]!;
      const capResult = captionResults[i];
      const caps = capResult?.status === "fulfilled" ? capResult.value : [];
      const s = mbStreamToStremio(stream, language, req, caps);
      if (s) results.push(s);
    }
  }

  return results;
}

async function getMovieBoxStreams(
  meta: ResolvedMeta,
  season: number,
  episode: number,
  req: Request,
  logKey: string,
): Promise<Record<string, unknown>[]> {
  try {
    const isSeries = meta.type === "series";
    const mbSeason = isSeries ? season : 0;
    const mbEpisode = isSeries ? episode : 0;

    let subjectId = await resolveSubjectId(meta.title, meta.year, isSeries, logKey);

    if (!subjectId && meta.aliases.length) {
      for (const alias of meta.aliases.slice(0, 3)) {
        const altId = await resolveSubjectId(alias, meta.year, isSeries, logKey);
        if (altId) {
          return fetchMovieBoxById(altId, mbSeason, mbEpisode, req, logKey);
        }
      }
    }

    if (!subjectId) {
      logger.warn({ title: meta.title }, "MovieBox: subject not found");
      return [];
    }

    return fetchMovieBoxById(subjectId, mbSeason, mbEpisode, req, logKey);
  } catch (err) {
    logger.error({ err, imdbId: meta.imdbId }, "MovieBox: provider error");
    return [];
  }
}

// ─── RareAnime helpers ────────────────────────────────────────────────────────

async function withTimeoutRA<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function normaliseRAEpisodeNumbers(eps: RAEpisodeLink[]): RAEpisodeLink[] {
  if (eps.length === 0) return eps;
  const sorted = [...eps].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const minEp = sorted[0].episodeNumber;
  if (minEp > 100) {
    return sorted.map((ep, idx) => ({ ...ep, episodeNumber: idx + 1, title: `Episode ${idx + 1}` }));
  }
  return sorted;
}

function parseRareanimeStreamId(rawId: string): { baseSlug: string; season: number; episodeNum: number } | null {
  const without = rawId.replace(/^rareanime:/, "");
  const parts = without.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]) && /^\d+$/.test(parts[parts.length - 2])) {
    const episodeNum = parseInt(parts[parts.length - 1], 10);
    const season = parseInt(parts[parts.length - 2], 10);
    const baseSlug = parts.slice(0, -2).join(":");
    return { baseSlug, season, episodeNum };
  }
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    const episodeNum = parseInt(parts[parts.length - 1], 10);
    const baseSlug = parts.slice(0, -1).join(":");
    return { baseSlug, season: 1, episodeNum };
  }
  return { baseSlug: without, season: 1, episodeNum: 1 };
}

async function resolveRAEpisodeStream(
  episodes: RAEpisodeLink[],
  episodeNum: number,
  pageUrl: string,
  addonBase: string
): Promise<Record<string, unknown> | null> {
  let candidates = episodes.filter((e) => e.episodeNumber === episodeNum);
  if (candidates.length === 0 && episodeNum >= 1 && episodeNum <= episodes.length) {
    candidates = [episodes[episodeNum - 1]];
  }
  if (candidates.length === 0) return null;

  let argonId: string | null = null;
  let resolvedEp = candidates[0];

  for (const candidate of candidates) {
    const id = await resolveCodedewToArgonId(candidate.codedewUrl);
    if (id) { argonId = id; resolvedEp = candidate; break; }
  }

  if (!argonId) return null;

  const streamResult = await extractStreamFromArgon(argonId, pageUrl);
  if (!streamResult?.url) return null;

  // Encode session cookies so the HLS proxy can forward them to the CDN.
  // The argon embed sets cookies that groovy.monster's CDN validates on
  // every m3u8 and segment request — without them the CDN returns 403.
  const ckEncoded = streamResult.cookies
    ? Buffer.from(streamResult.cookies, "utf8").toString("base64url")
    : "";

  const proxyUrl =
    `${addonBase}/api/hls/master.m3u8` +
    `?url=${encodeURIComponent(streamResult.url)}` +
    `&ref=${encodeURIComponent("https://groovy.monster/")}` +
    (ckEncoded ? `&ck=${encodeURIComponent(ckEncoded)}` : "");

  return {
    url: proxyUrl,
    title: resolvedEp.title || `Episode ${episodeNum}`,
    name: "🌙 RareAnime [HLS]",
    behaviorHints: {
      notWebReady: false,
      bingeGroup: `rareanime-${raSlugFromUrl(pageUrl)}`,
    },
  };
}

async function getRareAnimeNativeStreams(
  rawId: string,
  type: string,
  req: Request
): Promise<Record<string, unknown>[]> {
  const addonBase = apiBase(req).replace(/\/api$/, "");

  // ── Atoon stream ─────────────────────────────────────────────────────────
  if (rawId.startsWith("atoon:")) {
    const parts = rawId.replace(/^atoon:/, "").split(":");
    const isOldFormat = /^\d+$/.test(parts[0]);
    let archiveId: number;
    let episodeNum: number;

    if (isOldFormat) {
      archiveId = parseInt(parts[0], 10);
      episodeNum = parts.length >= 2 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 1;
    } else {
      const showSlug = parts[0];
      const season = parts.length >= 3 ? parseInt(parts[1], 10) : 1;
      episodeNum = parts.length >= 3 ? parseInt(parts[2], 10) : (parts.length >= 2 ? parseInt(parts[1], 10) : 1);
      await raBuildAtoonCatalog();
      const showSeasons = getAtoonShowSeasons(showSlug);
      const seasonEntry = showSeasons.find((s) => s.season === season);
      if (!seasonEntry) {
        logger.info({ showSlug, requestedSeason: season, availableSeasons: showSeasons.map((s) => s.season) }, "RareAnime/Atoon: requested season not available, skipping");
        return [];
      }
      archiveId = seasonEntry.archiveId;
    }

    const episodes = await getAtoonEpisodeLinks(archiveId);
    if (episodes.length === 0) return [];
    const archiveUrl = `https://store.animetoonhindi.com/archives/${archiveId}`;
    const stream = await resolveRAEpisodeStream(episodes, episodeNum, archiveUrl, addonBase);
    return stream ? [stream] : [];
  }

  // ── RareAnime stream ─────────────────────────────────────────────────────
  await raGetAllCatalogItems();
  const parsed = parseRareanimeStreamId(rawId);
  if (!parsed) return [];
  const { baseSlug, season, episodeNum } = parsed;

  const knownSeasons = getSeasonSlugs(baseSlug);
  const seasons = await withTimeoutRA(discoverAllSeasons(baseSlug, knownSeasons), 12_000) ?? knownSeasons;

  let targetSlug: string;
  if (seasons.length === 0) {
    targetSlug = baseSlug;
  } else {
    const entry = seasons.find((s: RASeasonEntry) => s.season === season);
    if (!entry) {
      // Requested season not found in RareAnime — return nothing rather than
      // silently falling back to season 1 and serving wrong episode content.
      logger.info({ baseSlug, requestedSeason: season, availableSeasons: seasons.map((s: RASeasonEntry) => s.season) }, "RareAnime: requested season not available, skipping");
      return [];
    }
    targetSlug = entry.slug;
  }

  const pageUrl = `https://www.rareanimes.buzz/hindi/${targetSlug}/`;
  const rawEps = await withTimeoutRA(raGetEpisodeLinks(pageUrl), 10_000) ?? [];
  const targetEp = type === "movie" ? 1 : episodeNum;
  const epInRare = rawEps.some((e: RAEpisodeLink) => e.episodeNumber === targetEp) || (targetEp >= 1 && targetEp <= rawEps.length);
  const needAtoon = rawEps.length === 0 || rawEps.length < 10 || !epInRare || rareBaseToAtoonSlug.has(baseSlug);

  let normAtoon: RAEpisodeLink[] = [];
  if (needAtoon) {
    let atoonRaw = await withTimeoutRA(findAndScrapeAtoonEpisodes(targetSlug), 12_000) ?? [];
    if (atoonRaw.length === 0) {
      atoonRaw = await withTimeoutRA(getAtoonEpsForBaseSlug(baseSlug, season), 12_000) ?? [];
    }
    if (atoonRaw.length > 0) normAtoon = normaliseRAEpisodeNumbers(atoonRaw);
  }

  const atoonIsBetter = (rawEps.length < 5 && normAtoon.length > rawEps.length) || !epInRare;

  if (normAtoon.length > 0 && atoonIsBetter) {
    const stream = await resolveRAEpisodeStream(normAtoon, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  if (rawEps.length > 0) {
    const normalised = normaliseRAEpisodeNumbers(rawEps);
    const stream = await resolveRAEpisodeStream(normalised, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  if (normAtoon.length > 0 && !atoonIsBetter) {
    const stream = await resolveRAEpisodeStream(normAtoon, targetEp, pageUrl, addonBase);
    if (stream) return [stream];
  }

  return [];
}

/**
 * Strip every non-alphanumeric character so titles like "Crayon Shin-chan"
 * and "Shinchan" collapse to the same token string ("crayonshinchan" ⊃ "shinchan").
 * This handles hyphens, colons, apostrophes and other punctuation differences
 * between Cinemeta/TMDB titles and the short names used on rareanimes.buzz.
 */
function tokeniseRA(s: string): string {
  // Normalize accents (é→e, ō→o, etc.) before stripping so "Pokémon" → "pokemon"
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Title-based lookup: try to match a resolved title against the rareanime catalog and return streams */
async function getRareAnimeStreamsByTitle(
  title: string,
  type: string,
  season: number,
  episode: number,
  req: Request,
  aliases: string[] = [],
): Promise<Record<string, unknown>[]> {
  try {
    const titleTok = tokeniseRA(title);
    const aliasToks = aliases.map(tokeniseRA).filter(Boolean);

    /** Returns true if the catalog entry name matches this request's title or any alias */
    const isMatch = (catName: string): boolean => {
      const catTok = tokeniseRA(catName);
      if (!catTok) return false;
      // catTok.startsWith(titleTok): "narutoallseasonhindi".startsWith("naruto") ✓
      //   but NOT "borutonarutonext...".startsWith("naruto") — prevents wrong matches
      // titleTok.includes(catTok): "crayonshinchan".includes("shinchan") ✓ — title is more specific
      if (catTok === titleTok || catTok.startsWith(titleTok) || titleTok.includes(catTok)) return true;
      for (const aTok of aliasToks) {
        if (aTok && (catTok === aTok || catTok.startsWith(aTok) || aTok.includes(catTok))) return true;
      }
      return false;
    };

    const [allMetas, atoonItems] = await Promise.all([
      withTimeoutRA(raGetAllCatalogItems(), 15_000),
      withTimeoutRA(raBuildAtoonCatalog(), 15_000),
    ]);

    // "All movies" collection entries (e.g. "Doraemon All Movies") must NOT be matched
    // for series episode requests.  Both catalog types can be "series" on rareanimes.buzz,
    // so we rely on name content rather than the type field.
    const isMovieColl = (name: string) => /\ball\s*movies?\b|\bmovies?\s*collection\b/i.test(name);
    const notMovieColl = (name: string) => type !== "series" || !isMovieColl(name);

    // Pass 1: exact token match (skip movie-collections for series); Pass 2: same without skip;
    // Pass 3: fuzzy startsWith match (skip movie-collections for series); Pass 4: fuzzy no-skip.
    const rareMatch =
      (allMetas ?? []).find((m: RACatalogMeta) => tokeniseRA(m.name) === titleTok && notMovieColl(m.name)) ||
      (allMetas ?? []).find((m: RACatalogMeta) => tokeniseRA(m.name) === titleTok) ||
      (allMetas ?? []).find((m: RACatalogMeta) => isMatch(m.name) && notMovieColl(m.name)) ||
      (allMetas ?? []).find((m: RACatalogMeta) => isMatch(m.name));
    const atoonMatch =
      (atoonItems ?? []).find((m) => tokeniseRA(m.name) === titleTok && notMovieColl(m.name)) ||
      (atoonItems ?? []).find((m) => tokeniseRA(m.name) === titleTok) ||
      (atoonItems ?? []).find((m) => isMatch(m.name) && notMovieColl(m.name)) ||
      (atoonItems ?? []).find((m) => isMatch(m.name));

    const matchedId = rareMatch?.id || atoonMatch?.id;
    if (!matchedId) {
      logger.info({ title, titleTok, aliasCount: aliasToks.length }, "RareAnime: no title match in catalog");
      return [];
    }

    const newId = type === "series" ? `${matchedId}:${season}:${episode}` : matchedId;
    logger.info({ title, matchedId, newId }, "RareAnime: title match found");
    return getRareAnimeNativeStreams(newId, type, req);
  } catch (err) {
    logger.error({ err, title }, "RareAnime: title-based stream error");
    return [];
  }
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function dedup(streams: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return streams.filter((s) => {
    const url = s["url"] as string;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// ─── Premium stream formatter ─────────────────────────────────────────────────
// Applies rich emoji-formatted titles to all streams before returning them.
// Preserves the provider's stream `name` (badge) and rewrites `title` with
// structured metadata so Stremio's popover shows nicely formatted info.
// Also removes the legacy `description` field so Stremio only uses `title`.
function premiumFormat(
  streams: Record<string, unknown>[],
  contentName: string,
  contentType: string,
  season: number,
  episode: number,
): Record<string, unknown>[] {
  return streams.map((s) => {
    const rawName  = String(s["name"]        ?? "");
    const rawTitle = String(s["title"]       ?? "");
    const rawDesc  = String(s["description"] ?? "");
    // Scan all text fields so providers that store quality in `description`
    // (e.g. NetMirror: "1080p · server proxy") are correctly extracted.
    const combined = rawName + " " + rawTitle + " " + rawDesc;

    // Extract quality
    const qMatch = combined.match(/\b(2160p|4K|1080p|720p|480p|360p|SD)\b/i);
    const quality = qMatch ? qMatch[1]!.toUpperCase() : "";

    // Extract audio languages
    const audioMatch = combined.match(
      /\b(Hindi|English|Tamil|Telugu|Japanese|Bengali|Korean|Original|Multi(?:[-\s]?Audio)?|Dual[-\s]?Audio)[^|·\n,]*/i,
    );
    const audio = audioMatch ? audioMatch[0].trim() : "";

    // Build multi-line title
    const lines: string[] = [];
    if (contentName) {
      lines.push(`🎬 ${contentType === "series" ? "Series" : "Movie"}: ${contentName}`);
    }
    if (contentType === "series" && season && episode) {
      lines.push(`📺 Episode: S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
    }
    if (audio)   lines.push(`🔊 Audio: ${audio}`);
    if (quality) lines.push(`🎥 Quality: ${quality}`);
    lines.push("⚡ By @Master_si");

    // Remove `description` — it's the legacy Stremio field superseded by `title`.
    // Having both simultaneously can cause the stream to be hidden in some
    // Stremio clients (they treat it as a conflicting/malformed object).
    const { description: _drop, ...rest } = s;
    return { ...rest, title: lines.join("\n") };
  });
}

// ─── Stream endpoint ──────────────────────────────────────────────────────────

router.get("/stream/:type/:id.json", async (req, res) => {
  stremioHeaders(res);
  res.setHeader("Cache-Control", "max-age=60");
  const { type, id } = req.params;
  logger.info({ type, id }, "Stremio: stream request");

  try {
    // ── Native rareanime: / atoon: IDs ───────────────────────────────────────
    if (id.startsWith("rareanime:") || id.startsWith("atoon:")) {
      try {
        const streams = await getRareAnimeNativeStreams(id, type, req);
        logger.info({ id, count: streams.length }, "Stremio: rareanime native streams");
        res.json({ streams });
      } catch (err) {
        logger.error({ err, id }, "RareAnime: native stream error");
        res.json({ streams: [] });
      }
      return;
    }

    // ── Native hd4u: IDs — HDHub4U + MovieBox ────────────────────────────────
    if (id.startsWith("hd4u:")) {
      const parts = id.split(":");
      const hd4uSeason  = parts[2] !== undefined ? parseInt(parts[2], 10) : 0;
      const hd4uEpisode = parts[3] !== undefined ? parseInt(parts[3], 10) : 0;
      const hd4uBaseId  = parts.length >= 3 ? parts.slice(0, 2).join(":") : id;
      const hd4uPageUrl = decodeId(hd4uBaseId);

      const hd4uPageMeta = await getMeta(hd4uPageUrl).catch(() => null);

      let mbStreamsPromise: Promise<Record<string, unknown>[]> = Promise.resolve([]);
      if (hd4uPageMeta?.name) {
        const synthMeta: ResolvedMeta = {
          imdbId: "",
          title: hd4uPageMeta.name,
          year: hd4uPageMeta.year,
          type: type as "movie" | "series",
          aliases: [],
        };
        const mbS = hd4uSeason  || (type === "series" ? 1 : 0);
        const mbE = hd4uEpisode || (type === "series" ? 1 : 0);
        mbStreamsPromise = getMovieBoxStreams(synthMeta, mbS, mbE, req, id);
      }

      const [hdResult, mbResult] = await Promise.allSettled([
        getHDHub4UStreams(id, type),
        mbStreamsPromise,
      ]);

      const hdStreams = hdResult.status === "fulfilled" ? hdResult.value : [];
      const mbStreams = mbResult.status === "fulfilled" ? mbResult.value : [];
      if (hdResult.status === "rejected") logger.error({ err: hdResult.reason, id }, "HDHub4U: crashed on hd4u:");
      if (mbResult.status === "rejected") logger.error({ err: mbResult.reason, id }, "MovieBox: crashed on hd4u:");

      const combined = dedup([...hdStreams, ...mbStreams]);
      logger.info({ id, hd: hdStreams.length, mb: mbStreams.length, combined: combined.length }, "Stremio: hd4u combined");
      res.json({ streams: combined });
      return;
    }

    // ── Native animedekho: IDs — AnimeDekho native + AnimeSalt by title ──────
    if (id.startsWith("animedekho:")) {
      const seMatch = id.match(/:(\d+):(\d+)$/);
      const season = seMatch ? parseInt(seMatch[1]!) : 1;
      const episode = seMatch ? parseInt(seMatch[2]!) : 1;
      const bareId = seMatch ? id.slice(0, id.lastIndexOf(`:${seMatch[1]}:`)) : id;

      const [adResult, saltResult] = await Promise.allSettled([
        getAnimeDekhoNativeStreams(bareId, type, season, episode),
        animeDekhoGetMeta(bareId).then(async (meta) => {
          if (!meta?.title) return [];
          const mediaType = type === "series" ? "series" : "movie";
          // Use title-based lookup — animedekho: IDs have no IMDB ID to pass to getStreams
          const saltStreams = await animesaltGetStreamsByTitle(String(meta.title), mediaType, season, episode).catch(() => []);
          const saltBase = apiBase(req);
          return saltStreams.map((s) => ({
            name: s.name,
            title: s.title,
            url: saltBase
              ? `${saltBase}/m3u8?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}&origin=${encodeURIComponent(s.origin)}`
              : s.url,
            subtitles: s.subtitles,
            behaviorHints: { notWebReady: false },
          }));
        }),
      ]);

      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const saltStreams = saltResult.status === "fulfilled" ? saltResult.value : [];

      if (adResult.status === "rejected") logger.error({ err: adResult.reason, id }, "AnimeDekho: native crashed");
      if (saltResult.status === "rejected") logger.error({ err: saltResult.reason, id }, "AnimeSalt (from animedekho): crashed");

      const combined = dedup([...adStreams, ...saltStreams]);
      logger.info({ id, ad: adStreams.length, salt: saltStreams.length, combined: combined.length }, "Stremio: animedekho combined");
      res.json({ streams: combined });
      return;
    }

    // ── IMDB IDs — all 6 providers ────────────────────────────────────────────
    if (id.startsWith("tt")) {
      const parts = id.split(":");
      const imdbId = parts[0]!;
      const contentType = type as "movie" | "series";
      const season = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;

      const ckey = streamCacheKey(imdbId, type, season, episode);
      const cached = getStreamCache(ckey);
      if (cached) { res.json({ streams: cached }); return; }

      const meta = await resolveMeta(imdbId, contentType);
      if (!meta) {
        logger.warn({ imdbId }, "Stremio: meta resolution failed");
        res.json({ streams: [] });
        return;
      }

      logger.info({ imdbId, title: meta.title, year: meta.year }, "Stremio: IMDB — querying 12 providers");
      logResolve({ imdbId, step: "resolve", status: "ok", detail: `${meta.title} (${meta.year})` });

      const sfTmdbId = await imdbToTmdbId(imdbId, type).catch(() => null);

      const ep = getEnabledProviders(req as RequestWithConfig);
      const [asResult, raResult, adResult, nmResult, mbResult, hmResult, hdResult, zmResult, ctResult, dmResult, sfResult, fkResult] = await Promise.allSettled([
        ep.has("animesalt") ? getAnimeSaltStreams(imdbId, type, season, episode, req) : Promise.resolve([]),
        ep.has("rareanime") ? getRareAnimeStreamsByTitle(meta.title, type, season, episode, req, meta.aliases) : Promise.resolve([]),
        ep.has("animedekho") ? getAnimeDekhoStreams(meta.title, type, season, episode) : Promise.resolve([]),
        ep.has("netmirror") ? fetchNetmirrorStreams(type as "movie" | "series", imdbId, season, episode) : Promise.resolve([]),
        ep.has("moviebox") ? getMovieBoxStreams(meta, season, episode, req, imdbId) : Promise.resolve([]),
        ep.has("hindmovies") ? hindmoviezGetStreams(type as "movie" | "series", imdbId, season, episode) : Promise.resolve([]),
        ep.has("hdhub4u") ? getHDHub4UStreams(imdbId, type, meta, season, episode) : Promise.resolve([]),
        ep.has("zinkmovies") ? getZinkMoviesStreams(imdbId, type, season, episode) : Promise.resolve([]),
        ep.has("castletv") ? getCastleTvStreams(imdbId, type, meta.title, meta.year, season, episode) : Promise.resolve([]),
        ep.has("dahmermovies") ? getDahmerMoviesStreams(meta.title, meta.year, type, season, episode) : Promise.resolve([]),
        ep.has("streamflix") ? getStreamflixStreams(sfTmdbId, type, season, episode) : Promise.resolve([]),
        ep.has("fourkdhub") ? get4KHDHubStreams(meta.title, meta.year, type, season, episode) : Promise.resolve([]),
      ]);

      const asStreams = asResult.status === "fulfilled" ? asResult.value : [];
      const raStreams = raResult.status === "fulfilled" ? raResult.value : [];
      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const nmStreams = nmResult.status === "fulfilled" ? nmResult.value : [];
      const mbStreams = mbResult.status === "fulfilled" ? mbResult.value : [];
      const hmStreams = hmResult.status === "fulfilled" ? proxyHindMoviezStreams(hmResult.value, req) : [];
      const hdStreams = hdResult.status === "fulfilled" ? hdResult.value : [];
      const zmStreams = zmResult.status === "fulfilled" ? zmResult.value : [];
      const ctStreams = ctResult.status === "fulfilled" ? ctResult.value : [];
      const dmStreams = dmResult.status === "fulfilled" ? dmResult.value : [];
      const sfStreams = sfResult.status === "fulfilled" ? sfResult.value : [];
      const fkStreams = fkResult.status === "fulfilled" ? fkResult.value : [];

      if (asResult.status === "rejected") logger.error({ err: asResult.reason, imdbId }, "AnimeSalt: crashed");
      if (raResult.status === "rejected") logger.error({ err: raResult.reason, imdbId }, "RareAnime: crashed");
      if (adResult.status === "rejected") logger.error({ err: adResult.reason, imdbId }, "AnimeDekho: crashed");
      if (nmResult.status === "rejected") logger.error({ err: nmResult.reason, imdbId }, "NetMirror: crashed");
      if (mbResult.status === "rejected") logger.error({ err: mbResult.reason, imdbId }, "MovieBox: crashed");
      if (hmResult.status === "rejected") logger.error({ err: hmResult.reason, imdbId }, "HindMoviez: crashed");
      if (hdResult.status === "rejected") logger.error({ err: hdResult.reason, imdbId }, "HDHub4U: crashed");
      if (zmResult.status === "rejected") logger.error({ err: zmResult.reason, imdbId }, "ZinkMovies: crashed");
      if (ctResult.status === "rejected") logger.error({ err: ctResult.reason, imdbId }, "CastleTV: crashed");
      if (dmResult.status === "rejected") logger.error({ err: dmResult.reason, imdbId }, "DahmerMovies: crashed");
      if (sfResult.status === "rejected") logger.error({ err: sfResult.reason, imdbId }, "StreamFlix: crashed");
      if (fkResult.status === "rejected") logger.error({ err: fkResult.reason, imdbId }, "4KHDHub: crashed");

      const raw = dedup(([...asStreams, ...raStreams, ...adStreams, ...nmStreams, ...sfStreams, ...ctStreams, ...dmStreams, ...mbStreams, ...hmStreams, ...fkStreams, ...hdStreams, ...zmStreams]) as Record<string, unknown>[]);
      const combined = premiumFormat(raw, meta.title, contentType, season, episode);
      logger.info(
        { imdbId, title: meta.title, as: asStreams.length, ra: raStreams.length, ad: adStreams.length, nm: nmStreams.length, mb: mbStreams.length, hm: hmStreams.length, hd: hdStreams.length, zm: zmStreams.length, ct: ctStreams.length, dm: dmStreams.length, sf: sfStreams.length, fk: fkStreams.length, combined: combined.length },
        "Stremio: 12 providers aggregated",
      );
      logResolve({ imdbId, step: "done", status: combined.length ? "ok" : "fail", detail: `as=${asStreams.length} ra=${raStreams.length} ad=${adStreams.length} nm=${nmStreams.length} mb=${mbStreams.length} hm=${hmStreams.length} hd=${hdStreams.length} zm=${zmStreams.length} ct=${ctStreams.length} dm=${dmStreams.length} sf=${sfStreams.length} fk=${fkStreams.length} total=${combined.length}` });

      setStreamCache(ckey, combined, TTL_MS_DEFAULT);
      res.json({ streams: combined });
      return;
    }

    // ── TMDB numeric IDs — all 6 providers ───────────────────────────────────
    if (id.startsWith("tmdb:")) {
      const parts = id.split(":");
      const numericTmdbId = parts[1]!;
      const contentType = type as "movie" | "series";
      const season = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;
      const episode = parts[3] !== undefined ? parseInt(parts[3], 10) : 1;

      const ckey = streamCacheKey(id, type, season, episode);
      const cached = getStreamCache(ckey);
      if (cached) { res.json({ streams: cached }); return; }

      const meta = await resolveMetaFromTmdbId(numericTmdbId, contentType);
      if (!meta) {
        logger.warn({ tmdbId: numericTmdbId }, "Stremio: TMDB meta resolution failed");
        res.json({ streams: [] });
        return;
      }

      logger.info({ tmdbId: numericTmdbId, imdbId: meta.imdbId, title: meta.title }, "Stremio: TMDB — querying 12 providers");
      logResolve({ imdbId: id, step: "resolve", status: "ok", detail: `${meta.title} (${meta.year}) imdb=${meta.imdbId}` });

      const hasImdb = meta.imdbId.startsWith("tt");
      const nmId = hasImdb ? meta.imdbId : id;

      const ep2 = getEnabledProviders(req as RequestWithConfig);
      const [asResult, raResult, adResult, nmResult, mbResult, hmResult, hdResult, zmResult, ctResult, dmResult, sfResult, fkResult] = await Promise.allSettled([
        (ep2.has("animesalt") && hasImdb) ? getAnimeSaltStreams(meta.imdbId, type, season, episode, req) : Promise.resolve([]),
        ep2.has("rareanime") ? getRareAnimeStreamsByTitle(meta.title, type, season, episode, req, meta.aliases) : Promise.resolve([]),
        ep2.has("animedekho") ? getAnimeDekhoStreams(meta.title, type, season, episode) : Promise.resolve([]),
        ep2.has("netmirror") ? fetchNetmirrorStreams(type as "movie" | "series", nmId, season, episode) : Promise.resolve([]),
        ep2.has("moviebox") ? getMovieBoxStreams(meta, season, episode, req, id) : Promise.resolve([]),
        (ep2.has("hindmovies") && hasImdb) ? hindmoviezGetStreams(type as "movie" | "series", meta.imdbId, season, episode) : Promise.resolve([]),
        ep2.has("hdhub4u") ? getHDHub4UStreams(meta.imdbId, type, meta, season, episode) : Promise.resolve([]),
        (ep2.has("zinkmovies") && hasImdb) ? getZinkMoviesStreams(meta.imdbId, type, season, episode) : Promise.resolve([]),
        (ep2.has("castletv") && hasImdb) ? getCastleTvStreams(meta.imdbId, type, meta.title, meta.year, season, episode) : Promise.resolve([]),
        ep2.has("dahmermovies") ? getDahmerMoviesStreams(meta.title, meta.year, type, season, episode) : Promise.resolve([]),
        ep2.has("streamflix") ? getStreamflixStreams(numericTmdbId, type, season, episode) : Promise.resolve([]),
        ep2.has("fourkdhub") ? get4KHDHubStreams(meta.title, meta.year, type, season, episode) : Promise.resolve([]),
      ]);

      const asStreams = asResult.status === "fulfilled" ? asResult.value : [];
      const raStreams = raResult.status === "fulfilled" ? raResult.value : [];
      const adStreams = (adResult.status === "fulfilled" ? adResult.value : []).map((s) => adStreamToStremio(s, req));
      const nmStreams = nmResult.status === "fulfilled" ? nmResult.value : [];
      const mbStreams = mbResult.status === "fulfilled" ? mbResult.value : [];
      const hmStreams = hmResult.status === "fulfilled" ? proxyHindMoviezStreams(hmResult.value, req) : [];
      const hdStreams = hdResult.status === "fulfilled" ? hdResult.value : [];
      const zmStreams = zmResult.status === "fulfilled" ? zmResult.value : [];
      const ctStreams = ctResult.status === "fulfilled" ? ctResult.value : [];
      const dmStreams = dmResult.status === "fulfilled" ? dmResult.value : [];
      const sfStreams = sfResult.status === "fulfilled" ? sfResult.value : [];
      const fkStreams = fkResult.status === "fulfilled" ? fkResult.value : [];

      if (asResult.status === "rejected") logger.error({ err: asResult.reason, tmdbId: numericTmdbId }, "AnimeSalt: crashed");
      if (raResult.status === "rejected") logger.error({ err: raResult.reason, tmdbId: numericTmdbId }, "RareAnime: crashed");
      if (adResult.status === "rejected") logger.error({ err: adResult.reason, tmdbId: numericTmdbId }, "AnimeDekho: crashed");
      if (nmResult.status === "rejected") logger.error({ err: nmResult.reason, tmdbId: numericTmdbId }, "NetMirror: crashed");
      if (mbResult.status === "rejected") logger.error({ err: mbResult.reason, tmdbId: numericTmdbId }, "MovieBox: crashed");
      if (hmResult.status === "rejected") logger.error({ err: hmResult.reason, tmdbId: numericTmdbId }, "HindMoviez: crashed");
      if (hdResult.status === "rejected") logger.error({ err: hdResult.reason, tmdbId: numericTmdbId }, "HDHub4U: crashed");
      if (zmResult.status === "rejected") logger.error({ err: zmResult.reason, tmdbId: numericTmdbId }, "ZinkMovies: crashed");
      if (ctResult.status === "rejected") logger.error({ err: ctResult.reason, tmdbId: numericTmdbId }, "CastleTV: crashed");
      if (dmResult.status === "rejected") logger.error({ err: dmResult.reason, tmdbId: numericTmdbId }, "DahmerMovies: crashed");
      if (sfResult.status === "rejected") logger.error({ err: sfResult.reason, tmdbId: numericTmdbId }, "StreamFlix: crashed");
      if (fkResult.status === "rejected") logger.error({ err: fkResult.reason, tmdbId: numericTmdbId }, "4KHDHub: crashed");

      const raw2 = dedup(([...asStreams, ...raStreams, ...adStreams, ...nmStreams, ...sfStreams, ...ctStreams, ...dmStreams, ...mbStreams, ...hmStreams, ...fkStreams, ...hdStreams, ...zmStreams]) as Record<string, unknown>[]);
      const combined = premiumFormat(raw2, meta.title, contentType, season, episode);
      logger.info(
        { tmdbId: numericTmdbId, title: meta.title, as: asStreams.length, ra: raStreams.length, ad: adStreams.length, nm: nmStreams.length, mb: mbStreams.length, hm: hmStreams.length, hd: hdStreams.length, zm: zmStreams.length, ct: ctStreams.length, dm: dmStreams.length, sf: sfStreams.length, fk: fkStreams.length, combined: combined.length },
        "Stremio: TMDB 12 providers aggregated",
      );
      logResolve({ imdbId: id, step: "done", status: combined.length ? "ok" : "fail", detail: `as=${asStreams.length} ra=${raStreams.length} ad=${adStreams.length} nm=${nmStreams.length} mb=${mbStreams.length} hm=${hmStreams.length} hd=${hdStreams.length} zm=${zmStreams.length} ct=${ctStreams.length} dm=${dmStreams.length} sf=${sfStreams.length} fk=${fkStreams.length} total=${combined.length}` });

      setStreamCache(ckey, combined, TTL_MS_DEFAULT);
      res.json({ streams: combined });
      return;
    }

    logger.warn({ id }, "Stremio: unrecognised ID format");
    res.json({ streams: [] });
  } catch (e) {
    logger.error({ err: e, id }, "Stremio: stream error");
    res.json({ streams: [] });
  }
});

// ─── Cache stats ──────────────────────────────────────────────────────────────

router.get("/debug/cache", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(streamCacheStats());
});

export default router;
