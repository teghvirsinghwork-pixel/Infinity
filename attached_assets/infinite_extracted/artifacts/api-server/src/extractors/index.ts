import { extractHubCloud } from "./hubcloud.js";
import { extractHubDrive } from "./hubdrive.js";
import { extractHubCDN, extractHubcdnn } from "./hubcdn.js";
import { extractHblinks } from "./hblinks.js";
import { extractVidStack } from "./vidstack.js";
import { extractHdStream4u } from "./hdstream4u.js";
import { extractPixelDrain } from "./pixeldrain.js";
import { extractStreamTape } from "./streamtape.js";
import { logger } from "../lib/logger.js";
import { isDirectStreamUrl } from "./stream-utils.js";
import type { Stream } from "./types.js";

export type { Stream };
export { isDirectStreamUrl };

function prefixHdHub4u(streams: Stream[]): Stream[] {
  return streams.map((s) => ({
    ...s,
    name: s.name.startsWith("HDHub4U") ? s.name : `HDHub4U ${s.name}`,
  }));
}

export async function extractStreams(url: string): Promise<Stream[]> {
  const lower = url.toLowerCase();
  logger.info({ url }, "Extractor: dispatching");

  if (!url || url.startsWith("magnet:") || url.startsWith("mailto:")) {
    logger.debug({ url }, "Extractor: skipping invalid scheme");
    return [];
  }

  try {
    if (/hubdrive/i.test(url)) {
      return prefixHdHub4u(await extractHubDrive(url));
    }
    if (/hubcloud/i.test(url)) {
      return prefixHdHub4u(await extractHubCloud(url));
    }
    if (/hubcdnn?/i.test(url) && /reurl/i.test(url)) {
      return prefixHdHub4u(await extractHubcdnn(url));
    }
    if (/hubcdn/i.test(url)) {
      return prefixHdHub4u(await extractHubCDN(url));
    }
    if (/hblinks|hubstreamdad/i.test(url)) {
      return prefixHdHub4u(await extractHblinks(url));
    }
    if (/hubstream|vidstack/i.test(url)) {
      return prefixHdHub4u(await extractVidStack(url));
    }
    if (/hdstream4u/i.test(url)) {
      return prefixHdHub4u(await extractHdStream4u(url));
    }
    if (/pixeldrain/i.test(url)) {
      return prefixHdHub4u(await extractPixelDrain(url));
    }
    if (/streamtape/i.test(url)) {
      return prefixHdHub4u(await extractStreamTape(url));
    }

    if (/\.m3u8/.test(lower)) {
      return prefixHdHub4u([{ name: "Stream", title: "HLS", url, type: "hls" }]);
    }
    if (/\.mp4/.test(lower)) {
      return prefixHdHub4u([{ name: "Stream", title: "MP4", url, type: "mp4" }]);
    }

    if (isDirectStreamUrl(url)) {
      logger.info({ url }, "Extractor: passing through as direct CDN stream");
      return prefixHdHub4u([
        {
          name: "HDHub4U",
          title: "Direct Stream",
          url,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        },
      ]);
    }

    logger.debug({ url }, "Extractor: skipping — not a known direct stream URL");
    return [];
  } catch (e) {
    logger.error({ err: e, url }, "Extractor: error");
    return [];
  }
}
