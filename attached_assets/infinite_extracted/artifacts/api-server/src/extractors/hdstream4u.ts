import { getHtml } from "../utils/request.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

export async function extractHdStream4u(url: string): Promise<Stream[]> {
  logger.info({ url }, "HdStream4u: starting extraction");
  const streams: Stream[] = [];
  try {
    const html = await getHtml(url, { Referer: "https://hdhub4u.rehab" });

    const m3u8Patterns = [
      /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
      /source:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/i,
      /playerInstance\.setup\(\{[^}]*file:\s*['"]([^'"]+)['"]/s,
    ];

    for (const pattern of m3u8Patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) {
        const streamUrl = match[1].replace(/\\\//g, "/");
        logger.info({ streamUrl }, "HdStream4u: found m3u8");
        streams.push({
          name: "HdStream4u",
          title: "HLS Stream",
          url: streamUrl,
          type: "hls",
          headers: { Referer: url },
        });
        break;
      }
    }

    const mp4Match = /["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/i.exec(html);
    if (mp4Match?.[1] && streams.length === 0) {
      streams.push({
        name: "HdStream4u",
        title: "MP4 Stream",
        url: mp4Match[1],
        type: "mp4",
        headers: { Referer: url },
      });
    }
  } catch (e) {
    logger.error({ err: e, url }, "HdStream4u: error");
  }
  return streams;
}
