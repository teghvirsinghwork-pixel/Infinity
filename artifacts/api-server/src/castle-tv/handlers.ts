import {
  getHomePage,
  searchMovies,
  getMovieDetails,
  getVideoUrl,
  mapMovieType,
  type ContentItem,
  type SearchResultItem,
  type MovieDetails,
  type Track,
  type SubtitleData,
} from "./api.js";
import {
  fetchCinemetaMeta,
  isImdbId,
  parseImdbStreamId,
  titleSimilarity,
} from "./cinemeta.js";
import { getTmdbInfo, searchTmdbByTitle } from "./tmdb.js";
import { fetchDahmerStreams } from "./dahmermovies.js";
import { fetchStreamflixStreams } from "./streamflix.js";
import { logger } from "../lib/logger.js";

const ID_PREFIX = "castletv:";


export function makeStremioId(movieId: string | number): string {
  return `${ID_PREFIX}${movieId}`;
}

export function parseStremioId(stremioId: string): { movieId: string; episodeId: string | null } {
  const stripped = stremioId.startsWith(ID_PREFIX)
    ? stremioId.slice(ID_PREFIX.length)
    : stremioId;
  const parts = stripped.split(":");
  return { movieId: parts[0]!, episodeId: parts[1] ?? null };
}

interface MetaPreview {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  posterShape: string;
  year?: number;
  description?: string;
  imdbRating?: string;
}

function buildMetaPreview(item: ContentItem | SearchResultItem): MetaPreview | null {
  const idRaw = (item as ContentItem).redirectId ?? (item as SearchResultItem).id;
  const title = item.title;
  if (!idRaw || !title) return null;

  const type = mapMovieType(item.movieType);
  return {
    id: makeStremioId(idRaw),
    type,
    name: title,
    poster:
      (item as SearchResultItem).coverVerticalImage ??
      (item as ContentItem).coverImage ??
      (item as SearchResultItem).coverHorizontalImage ??
      undefined,
    posterShape: "poster",
    year: item.publishTime ? new Date(item.publishTime).getFullYear() : undefined,
    description: item.briefIntroduction ?? undefined,
    imdbRating: item.score != null ? String(item.score) : undefined,
  };
}

export async function handleCatalog(
  type: string,
  catalogId: string,
  extra: Record<string, string>,
): Promise<{ metas: MetaPreview[] }> {
  try {
    const skip = parseInt(extra.skip ?? "0", 10);
    const searchQuery = extra.search;

    if (searchQuery) {
      const page = Math.floor(skip / 30) + 1;
      const result = await searchMovies(searchQuery, page);
      const rows = result?.data?.rows ?? [];
      const metas = rows
        .map(buildMetaPreview)
        .filter((m): m is MetaPreview => m !== null && m.type === type);
      return { metas };
    }

    const page = Math.floor(skip / 17) + 1;
    const result = await getHomePage(page);
    const rows = result?.data?.rows ?? [];

    const metas: MetaPreview[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      for (const item of row.contents ?? []) {
        const meta = buildMetaPreview(item);
        if (!meta || meta.type !== type || seen.has(meta.id)) continue;
        seen.add(meta.id);
        metas.push(meta);
      }
    }

    return { metas };
  } catch (err) {
    logger.error({ err, catalogId }, "castle-tv catalog error");
    return { metas: [] };
  }
}

interface StremioMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  posterShape: string;
  description?: string;
  year?: number;
  imdbRating?: string;
  cast?: string[];
  director?: string[];
  genres?: string[];
  country?: string;
  videos?: StremioVideo[];
}

interface StremioVideo {
  id: string;
  title: string;
  season: number;
  episode: number;
  thumbnail?: string;
  released?: string;
}

function buildBaseMeta(stremioId: string, type: string, details: MovieDetails): StremioMeta {
  return {
    id: stremioId,
    type,
    name: details.title ?? "Unknown",
    poster: details.coverVerticalImage ?? details.coverHorizontalImage ?? undefined,
    background: details.coverHorizontalImage ?? undefined,
    posterShape: "poster",
    description: details.briefIntroduction ?? undefined,
    year: details.publishTime ? new Date(details.publishTime).getFullYear() : undefined,
    imdbRating: details.score != null ? String(details.score) : undefined,
    cast: details.actors?.map((a) => a.name ?? "").filter(Boolean),
    director: details.directors?.map((d) => d.name ?? "").filter(Boolean),
    genres: details.tags,
    country: details.countries?.join(", "),
  };
}

async function buildSeriesVideos(
  stremioId: string,
  details: MovieDetails,
): Promise<StremioVideo[]> {
  const seasons = details.seasons ?? [];

  if (seasons.length === 0) {
    const episodes = details.episodes ?? [];
    return episodes.map((ep) => ({
      id: `${stremioId}:${ep.id}`,
      title: ep.title ?? `Episode ${ep.number}`,
      season: details.seasonNumber ?? 1,
      episode: ep.number ?? 1,
      thumbnail: ep.coverImage ?? undefined,
      released: ep.onlineTime ? new Date(ep.onlineTime).toISOString() : undefined,
    }));
  }

  const seasonResults = await Promise.all(
    seasons.map(async (s) => {
      const seasonMovieId = String(s.movieId);
      try {
        const res = await getMovieDetails(seasonMovieId);
        return { seasonNumber: s.number ?? 1, movieId: seasonMovieId, data: res?.data };
      } catch {
        return { seasonNumber: s.number ?? 1, movieId: seasonMovieId, data: null };
      }
    }),
  );

  const videos: StremioVideo[] = [];
  for (const { seasonNumber, movieId, data } of seasonResults) {
    if (!data) continue;
    for (const ep of data.episodes ?? []) {
      videos.push({
        id: `castletv:${movieId}:${ep.id}`,
        title: ep.title ?? `Episode ${ep.number}`,
        season: seasonNumber,
        episode: ep.number ?? 1,
        thumbnail: ep.coverImage ?? undefined,
        released: ep.onlineTime ? new Date(ep.onlineTime).toISOString() : undefined,
      });
    }
  }

  return videos;
}

export async function handleMeta(
  type: string,
  stremioId: string,
): Promise<{ meta: StremioMeta | null }> {
  try {
    if (isImdbId(stremioId)) {
      return { meta: null };
    }

    const { movieId } = parseStremioId(stremioId);
    const result = await getMovieDetails(movieId);
    if (!result?.data) return { meta: null };

    const meta = buildBaseMeta(stremioId, type, result.data);
    if (type === "series") {
      meta.videos = await buildSeriesVideos(stremioId, result.data);
    }
    return { meta };
  } catch (err) {
    logger.error({ err, stremioId }, "castle-tv meta error");
    return { meta: null };
  }
}

interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

interface StremioStream {
  url: string;
  name: string;
  title: string;
  subtitles?: StremioSubtitle[];
  behaviorHints?: {
    notWebReady?: boolean;
    headers?: Record<string, string>;
  };
}

const RESOLUTIONS = [3, 2, 1] as const;
const RESOLUTION_LABELS: Record<number, string> = { 3: "1080p", 2: "720p", 1: "480p" };

function extractSubtitles(rawSubs: SubtitleData[] | undefined): StremioSubtitle[] {
  if (!rawSubs?.length) return [];
  return rawSubs
    .filter((s) => !!s.url)
    .map((s, i) => ({
      id: `castletv-sub-${s.languageId ?? s.abbreviate ?? i}`,
      url: s.url!,
      lang: s.abbreviate ?? s.title ?? "unknown",
    }));
}

async function fetchStreams(
  movieId: string,
  episodeId: string,
  tracks: Track[],
): Promise<StremioStream[]> {
  const streams: StremioStream[] = [];
  const hasIndividualVideo = tracks.some((t) => t.existIndividualVideo === true);

  if (!hasIndividualVideo || tracks.length === 0) {
    const langNames =
      tracks
        .map((t) => t.languageName ?? t.abbreviate)
        .filter((n): n is string => !!n)
        .join(", ") || "Default";

    for (const resolution of RESOLUTIONS) {
      try {
        const result = await getVideoUrl(movieId, episodeId, resolution);
        const videoData = result?.data;
        if (!videoData?.videoUrl || videoData.permissionDenied) continue;

        const isPreview = videoData.videoUrl.includes("preview");
        const subtitles = extractSubtitles(videoData.subtitles);
        streams.push({
          url: videoData.videoUrl,
          name: "Castle TV",
          title: isPreview
            ? `${langNames} — ${RESOLUTION_LABELS[resolution]} ⚠️ Preview (Premium)`
            : `${langNames} — ${RESOLUTION_LABELS[resolution]}`,
          subtitles: subtitles.length ? subtitles : undefined,
          behaviorHints: { notWebReady: true, headers: { Referer: "https://api.fstcy.com" } },
        });
        break;
      } catch {
        continue;
      }
    }
  } else {
    for (const track of tracks) {
      if (!track.languageId) continue;
      const langName = track.languageName ?? track.abbreviate ?? "Unknown";
      for (const resolution of RESOLUTIONS) {
        try {
          const result = await getVideoUrl(movieId, episodeId, resolution, track.languageId);
          const videoData = result?.data;
          if (!videoData?.videoUrl || videoData.permissionDenied) continue;

          const isPreview = videoData.videoUrl.includes("preview");
          const subtitles = extractSubtitles(videoData.subtitles);
          streams.push({
            url: videoData.videoUrl,
            name: "Castle TV",
            title: isPreview
              ? `${langName} — ${RESOLUTION_LABELS[resolution]} ⚠️ Preview (Premium)`
              : `${langName} — ${RESOLUTION_LABELS[resolution]}`,
            subtitles: subtitles.length ? subtitles : undefined,
            behaviorHints: { notWebReady: true, headers: { Referer: "https://api.fstcy.com" } },
          });
          break;
        } catch {
          continue;
        }
      }
    }
  }

  return streams;
}

function strictTitleScore(candidate: string, query: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const nc = norm(candidate);
  const nq = norm(query);
  if (nc === nq) return 1.0;
  const wc = new Set(nc.split(" ").filter(Boolean));
  const wq = new Set(nq.split(" ").filter(Boolean));
  if (wc.size === 0 || wq.size === 0) return 0;
  const intersection = [...wq].filter((w) => wc.has(w)).length;
  const union = new Set([...wc, ...wq]).size;
  return intersection / union;
}

async function findCastleTvMatch(
  title: string,
  year: number | undefined,
  type: string,
): Promise<{ movieId: string; details: MovieDetails } | null> {
  try {
    const searchResult = await searchMovies(title);
    const rows = searchResult?.data?.rows ?? [];

    if (rows.length === 0) return null;

    type ScoredRow = { row: SearchResultItem; baseScore: number; finalScore: number };
    const scored: ScoredRow[] = rows
      .filter((r) => mapMovieType(r.movieType) === type)
      .map((row) => {
        const baseScore = strictTitleScore(row.title ?? "", title);
        let finalScore = baseScore;
        if (year && row.publishTime) {
          const rowYear = new Date(row.publishTime).getFullYear();
          if (rowYear === year) finalScore += 0.2;
          else if (Math.abs(rowYear - year) === 1) finalScore += 0.1;
        }
        return { row, baseScore, finalScore };
      });

    if (scored.length === 0) return null;

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const best = scored[0]!;

    if (best.baseScore < 0.75) {
      logger.info(
        { title, bestMatch: best.row.title, baseScore: best.baseScore, finalScore: best.finalScore },
        "castle-tv: no confident match, skipping",
      );
      return null;
    }

    logger.info(
      { title, bestMatch: best.row.title, baseScore: best.baseScore, finalScore: best.finalScore },
      "castle-tv: matched",
    );

    const movieId = String(best.row.id);
    const detailsResult = await getMovieDetails(movieId);
    if (!detailsResult?.data) return null;

    return { movieId, details: detailsResult.data };
  } catch (err) {
    logger.error({ err, title }, "castle-tv findMatch error");
    return null;
  }
}

async function resolveSeasonMovie(
  details: MovieDetails,
  targetSeason: number,
): Promise<{ movieId: string; details: MovieDetails } | null> {
  const seasons = details.seasons ?? [];
  if (seasons.length === 0) return null;

  const matchingSeason = seasons.find((s) => s.number === targetSeason);
  if (!matchingSeason?.movieId) return null;

  const seasonMovieId = String(matchingSeason.movieId);
  const seasonDetails = await getMovieDetails(seasonMovieId);
  if (!seasonDetails?.data) return null;

  return { movieId: seasonMovieId, details: seasonDetails.data };
}

export async function handleStream(
  type: string,
  stremioId: string,
): Promise<{ streams: StremioStream[] }> {
  try {
    if (isImdbId(stremioId)) {
      return handleImdbStream(type, stremioId);
    }
    return handleCastleTvStream(type, stremioId);
  } catch (err) {
    logger.error({ err, stremioId }, "castle-tv stream error");
    return { streams: [] };
  }
}

async function handleCastleTvStream(
  type: string,
  stremioId: string,
): Promise<{ streams: StremioStream[] }> {
  const { movieId, episodeId: embeddedEpisodeId } = parseStremioId(stremioId);

  const detailsResult = await getMovieDetails(movieId);
  const details = detailsResult?.data;
  const episodes = details?.episodes ?? [];

  if (episodes.length === 0) {
    logger.warn({ movieId, type }, "castle-tv: no episodes found");
    return { streams: [] };
  }

  let episodeId: string;
  let tracks: Track[];
  let targetEpNumber: number | null = null;
  let targetSeason: number | null = null;

  if (embeddedEpisodeId) {
    const ep = episodes.find((e) => String(e.id) === embeddedEpisodeId) ?? episodes[0]!;
    episodeId = String(ep.id);
    tracks = ep.tracks ?? [];
    targetEpNumber = ep.number ?? null;
    targetSeason = details?.seasonNumber ?? 1;
  } else {
    const ep = episodes[0]!;
    episodeId = String(ep.id);
    tracks = ep.tracks ?? [];
  }

  const title = details?.title ?? "";
  const year = details?.publishTime ? new Date(details.publishTime).getFullYear() : undefined;

  const [castleStreams, dahmerStreams, streamflixStreams] = await Promise.all([
    fetchStreams(movieId, episodeId, tracks),
    title
      ? fetchDahmerStreams(title, year ?? null, targetSeason, targetEpNumber).catch((err) => {
          logger.warn({ err }, "castle-tv native: dahmermovies error");
          return [];
        })
      : Promise.resolve([]),
    title
      ? (async () => {
          try {
            const tmdbId = await searchTmdbByTitle(title, year, type as "movie" | "series");
            if (!tmdbId) return [];
            return fetchStreamflixStreams(
              tmdbId,
              type as "movie" | "series",
              targetSeason,
              targetEpNumber,
            ).catch(() => []);
          } catch {
            return [];
          }
        })()
      : Promise.resolve([]),
  ]);

  const streams: StremioStream[] = [
    ...castleStreams,
    ...(dahmerStreams as StremioStream[]),
    ...(streamflixStreams as StremioStream[]),
  ];

  logger.info(
    { movieId, title, castle: castleStreams.length, dahmermovies: dahmerStreams.length, streamflix: streamflixStreams.length },
    "castle-tv native: combined streams",
  );

  return { streams };
}

export async function getCastleTvImdbStreams(
  type: string,
  imdbId: string,
  title: string,
  year: number | undefined,
  season: number | null,
  episode: number | null,
): Promise<StremioStream[]> {
  const match = await findCastleTvMatch(title, year, type);
  if (!match) {
    logger.info({ imdbId, title }, "castle-tv: no matching content found");
    return [];
  }

  let { movieId, details } = match;

  if (type === "series" && season !== null) {
    const currentSeason = details.seasonNumber ?? 1;
    if (currentSeason !== season && (details.seasons ?? []).length > 0) {
      const resolved = await resolveSeasonMovie(details, season);
      if (resolved) {
        movieId = resolved.movieId;
        details = resolved.details;
      }
    }
  }

  const episodes = details.episodes ?? [];
  if (episodes.length === 0) {
    logger.warn({ movieId, title }, "castle-tv: no episodes in matched content");
    return [];
  }

  let targetEpisode = episodes[0]!;
  if (episode !== null) {
    const found = episodes.find((ep) => ep.number === episode);
    if (found) targetEpisode = found;
    else logger.warn({ episode }, "castle-tv: episode not found, using first");
  }

  const streams = await fetchStreams(movieId, String(targetEpisode.id), targetEpisode.tracks ?? []);
  logger.info({ imdbId, title, movieId, streamCount: streams.length }, "castle-tv: IMDB streams resolved");
  return streams;
}

async function handleImdbStream(
  type: string,
  stremioId: string,
): Promise<{ streams: StremioStream[] }> {
  const { imdbId, season, episode } = parseImdbStreamId(stremioId);

  const [cinemetaMeta, tmdbInfo] = await Promise.all([
    fetchCinemetaMeta(type, imdbId),
    getTmdbInfo(imdbId, type as "movie" | "series"),
  ]);

  const title = cinemetaMeta?.name ?? tmdbInfo?.title;
  const year = cinemetaMeta?.year ?? (tmdbInfo?.year ? parseInt(tmdbInfo.year, 10) : undefined);

  if (!title) {
    logger.warn({ imdbId }, "handleImdbStream: could not get title from cinemeta or tmdb");
    return { streams: [] };
  }
  logger.info({ imdbId, title, year, type, tmdbId: tmdbInfo?.tmdbId }, "handleImdbStream: running all providers");

  const [castleStreams, dahmerStreams, streamflixStreams] =
    await Promise.all([
      getCastleTvImdbStreams(type, imdbId, title, year, season, episode).catch(
        (err) => {
          logger.warn({ err }, "castle-tv provider error");
          return [] as StremioStream[];
        },
      ),
      fetchDahmerStreams(title, year ?? null, season, episode).catch((err) => {
        logger.warn({ err }, "dahmermovies provider error");
        return [];
      }),
      tmdbInfo
        ? fetchStreamflixStreams(
            tmdbInfo.tmdbId,
            type === "movie" ? "movie" : "series",
            season,
            episode,
          ).catch((err) => {
            logger.warn({ err }, "streamflix provider error");
            return [];
          })
        : Promise.resolve([]),
    ]);

  const streams: StremioStream[] = [
    ...castleStreams,
    ...(dahmerStreams as StremioStream[]),
    ...(streamflixStreams as StremioStream[]),
  ];

  logger.info(
    {
      imdbId,
      title,
      castle: castleStreams.length,
      dahmermovies: dahmerStreams.length,
      streamflix: streamflixStreams.length,
      total: streams.length,
    },
    "handleImdbStream: combined results",
  );

  return { streams };
}
