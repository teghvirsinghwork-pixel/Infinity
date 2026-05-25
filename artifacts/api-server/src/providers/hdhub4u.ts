import * as cheerio from "cheerio";
import { getHtml, getJson, BROWSER_HEADERS } from "../utils/request.js";
import {
  cleanTitle,
  getRedirectLinks,
  getSearchQuality,
  encodeId,
} from "../utils/index.js";
import { extractStreams } from "../extractors/index.js";
import type { Stream } from "../extractors/types.js";
import { logger } from "../lib/logger.js";
import {
  type ResolvedMeta,
  normalizeTitle,
  titleSimilarity,
} from "../lib/meta-resolver.js";

const TMDB_API_KEY = process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";
const TMDB_BASE = "https://image.tmdb.org/t/p/original";
const TMDB_API = "https://api.themoviedb.org/3";
const SEARCH_URL = "https://search.hdhub4u.glass";
const DOMAINS_URL =
  "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

export let MAIN_URL =
  process.env["HDHUB4U_URL"] ?? "https://new1.hdhub4u.limo";

async function resolveDomain(): Promise<void> {
  try {
    const data = await getJson<{ HDHUB4u?: string }>(DOMAINS_URL, {}, 8000);
    if (data.HDHUB4u) {
      MAIN_URL = data.HDHUB4u;
      logger.info({ MAIN_URL }, "HDHub4U: resolved live domain");
    }
  } catch (e) {
    logger.warn({ err: e }, "HDHub4U: domain resolution failed, using default");
  }
}

resolveDomain();

export interface CatalogItem {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  description?: string;
  year?: number;
  genres?: string[];
  imdbRating?: string;
  releaseInfo?: string;
  links?: string[];
}

export interface MetaItem {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  year?: number;
  genres?: string[];
  cast?: string[];
  imdbRating?: string;
  videos?: EpisodeItem[];
  links?: string[];
}

export interface EpisodeItem {
  id: string;
  title: string;
  season: number;
  episode: number;
  overview?: string;
  thumbnail?: string;
  released?: string;
  links?: string[];
}

function itemIdFromUrl(url: string): string {
  return encodeId(url);
}

export async function getHomepage(
  categoryPath: string,
  page: number,
): Promise<CatalogItem[]> {
  const base = categoryPath ? `${MAIN_URL}/${categoryPath}` : `${MAIN_URL}/`;
  const url = `${base}page/${page}/`;
  logger.info({ url }, "HDHub4U: fetching homepage");
  try {
    const html = await getHtml(url, BROWSER_HEADERS);
    const $ = cheerio.load(html);
    const items: CatalogItem[] = [];

    const isSeriesCategory = /web.?series|series|episode/i.test(categoryPath);

    $(".recent-movies > li.thumb").each((_, el) => {
      const titleRaw = $(el)
        .find("figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)")
        .text()
        .trim();
      const title = cleanTitle(titleRaw);
      const itemUrl = $(el)
        .find("figure:nth-child(1) > a:nth-child(2)")
        .attr("href") ?? "";
      const poster = $(el)
        .find("figure:nth-child(1) > img:nth-child(1)")
        .attr("src") ?? "";

      if (!itemUrl || !title) return;

      const id = itemIdFromUrl(itemUrl);
      const quality = getSearchQuality(titleRaw);

      const inferredType: "movie" | "series" =
        isSeriesCategory ||
        /\bseries\b|\bseason\b|\bs\d{2}e\d{2}\b/i.test(titleRaw)
          ? "series"
          : "movie";

      items.push({
        id,
        type: inferredType,
        name: title,
        poster,
        releaseInfo: quality ?? undefined,
      });
    });

    logger.info({ count: items.length }, "HDHub4U: homepage fetched");
    return items;
  } catch (e) {
    logger.error({ err: e, url }, "HDHub4U: homepage error");
    return [];
  }
}

function toAbsoluteUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return "https:" + url;
  return MAIN_URL.replace(/\/$/, "") + (url.startsWith("/") ? url : "/" + url);
}

export async function searchContent(
  query: string,
  page: number,
): Promise<CatalogItem[]> {
  const url =
    `${SEARCH_URL}/collections/post/documents/search` +
    `?q=${encodeURIComponent(query)}` +
    `&query_by=post_title,category` +
    `&query_by_weights=4,2` +
    `&sort_by=sort_by_date:desc` +
    `&limit=15` +
    `&highlight_fields=none` +
    `&use_cache=true` +
    `&page=${page}`;

  logger.info({ query, page }, "HDHub4U: searching");
  try {
    const data = await getJson<SearchResponse>(url, BROWSER_HEADERS);
    return (data.hits ?? []).map((hit) => {
      const permalink = toAbsoluteUrl(hit.document.permalink);
      return {
        id: itemIdFromUrl(permalink),
        type: "movie" as const,
        name: hit.document.post_title,
        poster: hit.document.post_thumbnail,
      };
    });
  } catch (e) {
    logger.error({ err: e, query }, "HDHub4U: search error");
    return [];
  }
}

export async function getMeta(pageUrl: string): Promise<MetaItem | null> {
  const absoluteUrl = toAbsoluteUrl(pageUrl);
  logger.info({ pageUrl: absoluteUrl }, "HDHub4U: fetching meta");
  try {
    const html = await getHtml(absoluteUrl, BROWSER_HEADERS);
    const $ = cheerio.load(html);

    let title = $(
      'h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], ' +
        'h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]',
    )
      .first()
      .text()
      .trim();
    if (!title) title = $("h1.page-title").first().text().trim();

    const seasonMatch = /\bSeason\s*(\d+)\b/i.exec(title);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    const image = $("meta[property='og:image']").attr("content") ?? "";
    const plot = $(".kno-rdesc .kno-rdesc").first().text().trim();
    const poster =
      $("main.page-body img.aligncenter").first().attr("src") ??
      $(".page-body img").first().attr("src") ?? "";

    const tvtype: "movie" | "series" =
      /season|series|episode|web.?series/i.test(title) ||
      /season|series|episode/i.test(absoluteUrl)
        ? "series"
        : "movie";

    let background = image;
    let description = plot || undefined;
    let year: number | undefined;
    const cast: string[] = [];
    const genres: string[] = [];
    const videos: EpisodeItem[] = [];

    const imdbUrl = $("div span a[href*='imdb.com']").attr("href") ?? "";
    const tmdbHref =
      $("div span a[href*='themoviedb.org']").attr("href") ?? "";
    let tmdbId = tmdbHref.split("/").pop()?.split("-")[0]?.split("?")[0] ?? "";
    const isTv = tmdbHref.includes("/tv/");

    if (!tmdbId && imdbUrl) {
      const imdbIdOnly = imdbUrl.split("title/")[1]?.split("/")[0] ?? "";
      if (imdbIdOnly) {
        try {
          const findData = await getJson<TmdbFindResponse>(
            `${TMDB_API}/find/${imdbIdOnly}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
          );
          const res =
            tvtype === "movie"
              ? findData.movie_results?.[0]
              : findData.tv_results?.[0];
          if (res?.id) tmdbId = String(res.id);
        } catch {
          // ignore
        }
      }
    }

    if (tmdbId) {
      try {
        const type = isTv || tvtype === "series" ? "tv" : "movie";
        const detailsData = await getJson<TmdbDetails>(
          `${TMDB_API}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=credits,external_ids`,
        );

        let metaName = detailsData.name ?? detailsData.title ?? title;
        if (
          seasonNumber &&
          !metaName.toLowerCase().includes(`season ${seasonNumber}`)
        ) {
          metaName = `${metaName} (Season ${seasonNumber})`;
        }

        description = detailsData.overview || description;
        const yearRaw =
          detailsData.release_date ?? detailsData.first_air_date ?? "";
        year = yearRaw ? parseInt(yearRaw.slice(0, 4)) : undefined;
        title = metaName;

        if (detailsData.backdrop_path) {
          background = TMDB_BASE + detailsData.backdrop_path;
        }

        detailsData.genres?.forEach((g) => genres.push(g.name));
        detailsData.credits?.cast?.slice(0, 10).forEach((c) => {
          if (c.name) cast.push(c.name);
        });

        if (tvtype === "series" && seasonNumber) {
          try {
            const seasonData = await getJson<TmdbSeason>(
              `${TMDB_API}/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`,
            );
            seasonData.episodes?.forEach((ep) => {
              videos.push({
                id: `${encodeId(absoluteUrl)}:${seasonNumber}:${ep.episode_number}`,
                title: ep.name,
                season: seasonNumber,
                episode: ep.episode_number,
                overview: ep.overview,
                thumbnail: ep.still_path ? TMDB_BASE + ep.still_path : undefined,
                released: ep.air_date,
              });
            });
          } catch {
            // ignore
          }
        }
      } catch (e) {
        logger.warn({ err: e, tmdbId }, "HDHub4U: TMDB details failed");
      }
    }

    const allPageLinks = extractAllLinks($);
    logger.info({ count: allPageLinks.length }, "HDHub4U: page links extracted");

    if (tvtype === "series") {
      const epLinksMap = extractEpisodeLinks($);
      const hasEpisodeLinks = Object.keys(epLinksMap).length > 0;

      if (hasEpisodeLinks) {
        const existingEpNums = new Set(videos.map((v) => v.episode));
        for (const [epNumStr, epLinks] of Object.entries(epLinksMap)) {
          const epNum = parseInt(epNumStr);
          if (epNum < 0) continue;
          if (!existingEpNums.has(epNum)) {
            videos.push({
              id: `${encodeId(absoluteUrl)}:${seasonNumber ?? 1}:${epNum}`,
              title: `Episode ${epNum}`,
              season: seasonNumber ?? 1,
              episode: epNum,
              links: epLinks,
            });
          } else {
            const ep = videos.find((v) => v.episode === epNum);
            if (ep) ep.links = epLinks;
          }
        }
      }

      // Only assign page-wide links as episode fallback when NO structured episode
      // sections exist on the page. If episode sections DO exist, using allPageLinks
      // as fallback would pollute episodes with unrelated movie download links that
      // appear on the same page (e.g. Shinchan movies on a Shinchan series page).
      if (!hasEpisodeLinks && videos.length > 0 && allPageLinks.length > 0) {
        for (const ep of videos) {
          if (!ep.links?.length) ep.links = allPageLinks;
        }
      }

      videos.sort((a, b) => a.episode - b.episode);
    }

    return {
      id: encodeId(absoluteUrl),
      type: tvtype,
      name: title,
      poster: poster || image,
      background,
      description,
      year,
      genres,
      cast,
      videos: videos.length > 0 ? videos : undefined,
      links: allPageLinks.length > 0 ? allPageLinks : undefined,
    };
  } catch (e) {
    logger.error({ err: e, pageUrl: absoluteUrl }, "HDHub4U: getMeta error");
    return null;
  }
}

// Keywords that indicate a candidate is a TV series / multi-episode release
const SERIES_INDICATORS = /\b(season|series|complete|episode|s\d{2}e\d{2}|s\d{2}\b|web.?series|hindi dubbed series)\b/i;

function scoreCandidateForMeta(
  candidateName: string,
  meta: ResolvedMeta,
  season: number,
): number {
  const isSeries = meta.type === "series";
  const nc = normalizeTitle(candidateName);

  let titleScore = titleSimilarity(meta.title, candidateName);
  for (const alias of meta.aliases) {
    const aliasScore = titleSimilarity(alias, candidateName);
    if (aliasScore > titleScore) titleScore = aliasScore;
  }

  if (titleScore < 0.2) {
    logger.debug({ candidateName, titleScore }, "HDHub4U: candidate rejected (low title score)");
    return 0;
  }

  // When searching for a MOVIE, outright reject any candidate that has series/season
  // indicators — e.g. searching "Obsession" (movie) must not match "Obsession Season 1"
  if (!isSeries && SERIES_INDICATORS.test(candidateName)) {
    logger.debug({ candidateName }, "HDHub4U: movie search, candidate has series indicators — rejecting");
    return 0;
  }

  let seasonBonus = 0;
  if (isSeries && season > 0) {
    const hasSeason = new RegExp(`season\\s*0*${season}\\b`, "i").test(nc);
    const hasAnyOtherSeason = /season\s*\d+/i.test(nc) && !hasSeason;
    const looksLikeSeries = SERIES_INDICATORS.test(candidateName);

    if (hasSeason) {
      // Candidate explicitly names the right season — strong positive signal
      seasonBonus = 0.35;
    } else if (!looksLikeSeries) {
      // No series indicators at all — this is a movie, not a series result.
      // Reject it outright regardless of title similarity: a movie named after
      // a series character (e.g. "Crayon Shinchan Our Dinosaur Diary 2024")
      // should NEVER match a series search, even with a high title score.
      logger.debug({ candidateName }, "HDHub4U: candidate rejected (series search, no series indicators — looks like a movie)");
      return 0;
    } else if (looksLikeSeries && !hasAnyOtherSeason) {
      // Has series indicators but no season number — mild positive (e.g. "Complete Series")
      seasonBonus = 0.05;
    } else if (hasAnyOtherSeason) {
      // Wrong season number — strong negative
      seasonBonus = -0.5;
    }
  }

  let yearBonus = 0;
  if (meta.year) {
    const yearMatch = /\b(19|20)\d{2}\b/.exec(candidateName);
    if (yearMatch) {
      const diff = Math.abs(parseInt(yearMatch[0]) - meta.year);
      if (diff === 0) yearBonus = 0.15;
      else if (diff === 1) yearBonus = 0.05;
      else if (diff > 3) yearBonus = -0.15;
    }
  }

  const total = titleScore + (isSeries ? seasonBonus : 0) + yearBonus;
  logger.debug({ candidateName, titleScore, seasonBonus, yearBonus, total }, "HDHub4U: candidate score");
  return Math.min(1.0, Math.max(0, total));
}

export async function findByMeta(
  meta: ResolvedMeta,
  season: number,
): Promise<MetaItem | null> {
  logger.info(
    { imdbId: meta.imdbId, title: meta.title, year: meta.year, type: meta.type, season },
    "HDHub4U: findByMeta start",
  );

  const isSeries = meta.type === "series";

  const queries: string[] = [];
  if (isSeries && season > 0) {
    queries.push(`${meta.title} Season ${season}`);
    queries.push(`${meta.title} S${String(season).padStart(2, "0")}`);
    for (const alias of meta.aliases.slice(0, 2)) {
      queries.push(`${alias} Season ${season}`);
    }
  }
  queries.push(meta.title);
  if (meta.year) queries.push(`${meta.title} ${meta.year}`);
  for (const alias of meta.aliases.slice(0, 3)) {
    queries.push(alias);
  }
  const stripped = meta.title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (stripped && stripped !== meta.title) queries.push(stripped);
  const words = meta.title.split(/\s+/);
  if (words.length > 3) queries.push(words.slice(0, 2).join(" "));

  const seen = new Set<string>();
  const uniqueQueries = queries.filter((q) => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });

  const seenIds = new Set<string>();
  const candidates: Array<{ item: CatalogItem; score: number }> = [];

  for (const query of uniqueQueries.slice(0, 6)) {
    let results: CatalogItem[];
    try {
      results = await searchContent(query, 1);
    } catch {
      continue;
    }

    for (const item of results) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);

      const score = scoreCandidateForMeta(item.name, meta, season);
      if (score > 0) candidates.push({ item, score });
    }

    if (candidates.some((c) => c.score >= 0.8)) break;
  }

  if (!candidates.length) {
    logger.warn({ imdbId: meta.imdbId, title: meta.title }, "HDHub4U: no candidates found");
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  logger.info(
    { imdbId: meta.imdbId, candidateName: best.item.name, score: best.score },
    "HDHub4U: best candidate",
  );

  if (best.score < 0.42) {
    logger.warn({ imdbId: meta.imdbId, candidateName: best.item.name, score: best.score }, "HDHub4U: best score too low, rejecting");
    return null;
  }

  const pageUrl = Buffer.from(best.item.id.replace("hd4u:", ""), "base64url").toString("utf8");
  return getMeta(pageUrl);
}

const STREAM_DOMAINS =
  /hubcdn|hubdrive|hubcloud|hblinks|hdstream4u|hubstream|pixeldrain|streamtape|gadgetsweb|hbstream/i;
const QUALITY_TEXT = /480p?|720p?|1080p?|2160p?|4[Kk]|WATCH|STREAM/i;
const SKIP_HREFS = /catimages|hdhub4u\.limo|hdhub4u\.glass|wp-content|javascript:|#$/;

function extractAllLinks($: cheerio.CheerioAPI): string[] {
  const links: string[] = [];

  $("h3 a, h4 a, h5 a, p a, div a")
    .toArray()
    .forEach((el) => {
      const href = ($(el).attr("href") ?? "").trim();
      if (!href || href.startsWith("#") || SKIP_HREFS.test(href)) return;
      const text = $(el).text().trim();
      if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test(text)) {
        links.push(href);
      }
    });

  return [...new Set(links)];
}

function extractEpisodeLinks($: cheerio.CheerioAPI): Record<number, string[]> {
  const epLinksMap: Record<number, string[]> = {};
  const episodeRegex = /EPi?SODE\s*[–\-—]?\s*(\d+)/i;

  let currentEpisode: number | null = null;

  $("h3, h4, h5").each((_, el) => {
    const element = $(el);
    const text = element.text().trim();

    const epNumMatch = episodeRegex.exec(text);
    if (epNumMatch) {
      currentEpisode = parseInt(epNumMatch[1]);
      element.find("a[href]").each((_, a) => {
        const href = ($(a).attr("href") ?? "").trim();
        if (!href || SKIP_HREFS.test(href)) return;
        if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test($(a).text())) {
          if (currentEpisode !== null) {
            if (!epLinksMap[currentEpisode]) epLinksMap[currentEpisode] = [];
            epLinksMap[currentEpisode].push(href);
          }
        }
      });
      return;
    }

    const links: string[] = [];
    element.find("a[href]").each((_, a) => {
      const href = ($(a).attr("href") ?? "").trim();
      if (!href || SKIP_HREFS.test(href)) return;
      const linkText = $(a).text().trim();
      if (STREAM_DOMAINS.test(href) || QUALITY_TEXT.test(linkText)) {
        links.push(href);
      }
    });

    if (links.length > 0) {
      const key = currentEpisode ?? -1;
      if (!epLinksMap[key]) epLinksMap[key] = [];
      epLinksMap[key].push(...links);
    }
  });

  return epLinksMap;
}

export async function getStreams(
  pageUrl: string,
  links: string[],
): Promise<Stream[]> {
  logger.info({ pageUrl, linkCount: links.length }, "HDHub4U: getting streams");
  const allStreams: Stream[] = [];

  const tasks = links.map(async (link) => {
    try {
      let finalLink = link;
      if (link.includes("?id=")) {
        const redirected = getRedirectLinks(link, link) as string | string[];
        finalLink = Array.isArray(redirected) ? (redirected[0] ?? link) : redirected;
        logger.info({ link, finalLink }, "HDHub4U: redirect resolved");
      }
      return await extractStreams(finalLink);
    } catch (e) {
      logger.error({ err: e, link }, "HDHub4U: stream extraction failed");
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "fulfilled") {
      allStreams.push(...result.value);
    }
  }

  return allStreams;
}

interface SearchResponse {
  hits: Array<{
    document: {
      id: string;
      permalink: string;
      post_title: string;
      post_thumbnail: string;
      category: string[];
    };
  }>;
}

interface TmdbFindResponse {
  movie_results?: Array<{ id: number; title?: string; name?: string }>;
  tv_results?: Array<{ id: number; title?: string; name?: string }>;
}

interface TmdbDetails {
  id: number;
  name?: string;
  title?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  backdrop_path?: string;
  genres?: Array<{ name: string }>;
  credits?: {
    cast?: Array<{ name: string; character?: string }>;
  };
  external_ids?: {
    imdb_id?: string;
  };
}

interface TmdbSeason {
  episodes?: Array<{
    episode_number: number;
    name: string;
    overview?: string;
    still_path?: string;
    air_date?: string;
    vote_average?: number;
  }>;
}
