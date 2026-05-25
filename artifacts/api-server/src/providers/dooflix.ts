const BASE_API = "https://panel.watchkaroabhi.com";
const API_KEY = "qNhKLJiZVyoKdi9NCQGz8CIGrpUijujE";
const HEADERS: Record<string, string> = {
  "X-Package-Name": "com.king.moja",
  "User-Agent": "dooflix",
  "X-App-Version": "305",
};
const STREAM_REFERER = "https://molop.art/";

export async function getStreams(tmdbId: string, mediaType = "movie", season?: number, episode?: number): Promise<any[]> {
  console.log(`[DooFlix] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
  try {
    let requestUrl: string;
    if (mediaType === "movie") {
      requestUrl = `${BASE_API}/api/3/movie/${tmdbId}/links?api_key=${API_KEY}`;
    } else {
      if (!season || !episode) { console.error("[DooFlix] Missing season or episode"); return []; }
      requestUrl = `${BASE_API}/api/3/tv/${tmdbId}/season/${season}/episode/${episode}/links?api_key=${API_KEY}`;
    }
    const response = await fetch(requestUrl, { headers: HEADERS });
    if (!response.ok) { console.log(`[DooFlix] API error: ${response.status}`); return []; }
    const data: any = await response.json();
    const links: any[] = data.links || [];
    const streams: any[] = [];
    for (const linkObj of links) {
      try {
        const res = await fetch(linkObj.url, {
          method: "GET",
          headers: { "Referer": STREAM_REFERER, "User-Agent": HEADERS["User-Agent"] },
          redirect: "manual",
        });
        const streamUrl = res.headers.get("location") || res.url;
        if (streamUrl && streamUrl !== linkObj.url) {
          streams.push({
            name: "ALLINONE | DooFlix",
            title: `DooFlix - ${linkObj.host || "Server"}`,
            url: streamUrl,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: { request: { "Referer": STREAM_REFERER, "User-Agent": HEADERS["User-Agent"] } },
            },
          });
        }
      } catch (e: any) {
        console.log(`[DooFlix] Error fetching redirect for ${linkObj.url}: ${e.message}`);
      }
    }
    return streams;
  } catch (error: any) {
    console.error(`[DooFlix] Error: ${error.message}`);
    return [];
  }
}
