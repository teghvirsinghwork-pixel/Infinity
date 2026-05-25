export const ADDON_ID = "community.infinitestreams.stremio";

export const manifest = {
  id: ADDON_ID,
  version: "8.0.0",
  name: "INFINITE STREAMS",
  description:
    "♾️ 9 providers. One addon. Zero compromise.\n" +
    "⛩️ AnimeSalt — Hindi, English & Japanese multi-audio anime HLS.\n" +
    "🌙 RareAnime India — Hindi & Tamil dubbed anime (rareanimes.buzz + animetoonhindi).\n" +
    "🇮🇳 AnimeDekho — Hindi/Tamil/Telugu dubbed anime via 15+ extractors.\n" +
    "🌐 NetMirror — 1080p mirrors of Netflix, Prime Video & Hotstar.\n" +
    "🎬 DooFlix — Fast API-based streams with TMDB integration.\n" +
    "🍿 MovieBox — Multi-audio: Hindi, Bengali, English & more.\n" +
    "🎞️ HindMoviez — Bollywood, Hollywood & Hindi-dubbed in 480p–4K.\n" +
    "📡 HDHub4U — Bollywood & Hollywood: Blu-Ray, IMAX & WebDL.\n" +
    "🎥 ZinkMovies — Bollywood, South Indian & multi-lang in 4K.\n" +
    "Supports IMDB, TMDB & Cinemeta IDs. | By @Master_si",
  logo: "https://i.imgur.com/YPqM5vW.png",
  background: "https://i.imgur.com/f4Rj2Qp.jpg",
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "infinitestreams_movies",
      name: "♾️ INFINITE STREAMS — Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "infinitestreams_series",
      name: "♾️ INFINITE STREAMS — Series",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "animesalt-anime",
      name: "⛩️ Anime Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "animesalt-anime-movies",
      name: "⛩️ Anime Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "animedekho-series",
      name: "🇮🇳 AnimeDekho — Series & Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "animedekho-movies",
      name: "🇮🇳 AnimeDekho — Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "hdhub4u-latest",
      name: "📡 HDHub4U — Latest",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "movie",
      id: "hdhub4u-bollywood",
      name: "📡 Bollywood",
      extra: [{ name: "skip" }],
    },
    {
      type: "movie",
      id: "hdhub4u-hollywood",
      name: "📡 Hollywood",
      extra: [{ name: "skip" }],
    },
    {
      type: "movie",
      id: "hdhub4u-hindi-dubbed",
      name: "📡 Hindi Dubbed",
      extra: [{ name: "skip" }],
    },
    {
      type: "movie",
      id: "hdhub4u-south",
      name: "📡 South Hindi Dubbed",
      extra: [{ name: "skip" }],
    },
    {
      type: "series",
      id: "hdhub4u-webseries",
      name: "📡 HDHub4U — Web Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip" }],
    },
    {
      type: "movie",
      id: "hindmoviez-movies",
      name: "🎞️ HindMoviez — Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "hindmoviez-series",
      name: "🎞️ HindMoviez — Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "rareanime-series",
      name: "🌙 RareAnime Series (Hindi)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "rareanime-movies",
      name: "🌙 RareAnime Movies (Hindi)",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "atoon-series",
      name: "🌙 AnimeToon Hindi Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "movie",
      id: "atoon-movies",
      name: "🌙 AnimeToon Hindi Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["hd4u:", "animedekho:", "rareanime:", "atoon:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "hd4u:", "tmdb:", "animedekho:", "rareanime:", "atoon:"] },
  ],
  idPrefixes: ["tt", "hd4u:", "tmdb:", "animedekho:", "rareanime:", "atoon:"],
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true,
    configurationRequired: false,
  },
};

export const CATALOG_MAP: Record<string, string> = {
  "hdhub4u-latest": "",
  "hdhub4u-bollywood": "category/bollywood-movies/",
  "hdhub4u-hollywood": "category/hollywood-movies/",
  "hdhub4u-hindi-dubbed": "category/hindi-dubbed/",
  "hdhub4u-south": "category/south-hindi-movies/",
  "hdhub4u-webseries": "category/web-series/",
};

// Provider config — order must match PROVIDER_LIST in routes/stremio.ts
// Index: 0=animesalt 1=rareanime 2=animedekho 3=netmirror 4=dooflix 5=moviebox 6=hindmovies 7=hdhub4u 8=zinkmovies
export const ALL_ENABLED_MASK = "111111111";
