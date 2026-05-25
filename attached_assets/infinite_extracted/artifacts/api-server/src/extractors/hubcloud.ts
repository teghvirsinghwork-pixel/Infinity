import * as cheerio from "cheerio";
import { getHtml, getNoRedirect } from "../utils/request.js";
import { getBaseUrl, getIndexQuality, cleanTitle } from "../utils/index.js";
import { logger } from "../lib/logger.js";
import type { Stream } from "./types.js";

const TAG = "HubCloud";

export async function extractHubCloud(
  url: string,
  referer = "",
): Promise<Stream[]> {
  const streams: Stream[] = [];
  logger.info({ url }, `${TAG}: starting extraction`);

  try {
    const uri = new URL(url);
    const baseUrl = `${uri.protocol}//${uri.host}`;

    let href: string;
    if (url.includes("hubcloud.php")) {
      href = url;
    } else {
      const html = await getHtml(url);
      const $ = cheerio.load(html);
      const rawHref = $("#download").attr("href") ?? "";
      href = rawHref.startsWith("http")
        ? rawHref
        : `${baseUrl.replace(/\/+$/, "")}/${rawHref.replace(/^\/+/, "")}`;
    }

    if (!href) {
      logger.warn({ url }, `${TAG}: no href found`);
      return streams;
    }

    logger.info({ href }, `${TAG}: fetching download page`);
    const downloadHtml = await getHtml(href);
    const $d = cheerio.load(downloadHtml);

    const size = $d("i#size").first().text() ?? "";
    const header = $d("div.card-header").first().text() ?? "";
    const headerDetails = cleanTitle(header);
    const quality = getIndexQuality(header);

    const labelExtras = [
      headerDetails ? `[${headerDetails}]` : "",
      size ? `[${size}]` : "",
    ]
      .filter(Boolean)
      .join(" ");

    $d("a.btn").each((_, el) => {
      const link = $d(el).attr("href") ?? "";
      const text = $d(el).text().toLowerCase();
      const srcName = referer || "HubCloud";

      logger.debug({ text, link }, `${TAG}: processing button`);

      if (!link) return;

      if (text.includes("fsl server")) {
        streams.push({
          name: `${srcName} [FSL Server]`,
          title: `FSL Server ${labelExtras}`,
          url: link,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("download file")) {
        streams.push({
          name: srcName,
          title: `Direct Download ${labelExtras}`,
          url: link,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("fslv2")) {
        streams.push({
          name: `${srcName} [FSLv2]`,
          title: `FSLv2 ${labelExtras}`,
          url: link,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("s3 server")) {
        streams.push({
          name: `${srcName} [S3 Server]`,
          title: `S3 ${labelExtras}`,
          url: link,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("mega server")) {
        streams.push({
          name: `${srcName} [Mega Server]`,
          title: `Mega ${labelExtras}`,
          url: link,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (
        text.includes("pixeldra") ||
        text.includes("pixel server") ||
        text.includes("pixeldrain")
      ) {
        const pixelBase = getBaseUrl(link);
        const finalUrl = link.includes("download")
          ? link
          : `${pixelBase}/api/file/${link.split("/").pop()}?download`;
        streams.push({
          name: `${srcName} [Pixeldrain]`,
          title: `Pixeldrain ${labelExtras}`,
          url: finalUrl,
          type: "mp4",
          behaviorHints: { notWebReady: false },
        });
      } else if (text.includes("buzzserver")) {
        void extractBuzzServer(link, srcName, labelExtras, quality, streams);
      } else {
        logger.debug({ text, link }, `${TAG}: unknown button type`);
      }
    });

    logger.info({ count: streams.length }, `${TAG}: extraction complete`);
  } catch (e) {
    logger.error({ err: e, url }, `${TAG}: error`);
  }
  return streams;
}

async function extractBuzzServer(
  link: string,
  srcName: string,
  labelExtras: string,
  _quality: number,
  streams: Stream[],
) {
  try {
    const resp = await getNoRedirect(`${link}/download`);
    const dlink =
      resp.headers["hx-redirect"] ?? resp.headers["location"] ?? "";
    if (dlink) {
      streams.push({
        name: `${srcName} [BuzzServer]`,
        title: `BuzzServer ${labelExtras}`,
        url: dlink,
        type: "mp4",
        behaviorHints: { notWebReady: false },
      });
    } else {
      logger.warn({}, "HubCloud BuzzServer: no redirect found");
    }
  } catch (e) {
    logger.error({ err: e }, "HubCloud BuzzServer: error");
  }
}
