import "./lib/proxy-agent.js";
import app from "./app";
import { logger } from "./lib/logger";
import { getAllCatalogItems, buildAtoonCatalog } from "./providers/rareanime/scraper.js";
import { startProxyPool } from "./lib/proxy-pool.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start free proxy pool in background (used for geo-restricted APIs like MovieBox).
  // Starts 5s after server is up so it doesn't slow the initial response.
  startProxyPool();

  // Pre-warm RareAnime catalogs in the background so they are ready
  // before the first IMDb/TMDB/Cinemeta stream request arrives.
  // Errors are swallowed — the server still serves all other providers.
  Promise.allSettled([
    getAllCatalogItems().then(() => logger.info("RareAnime catalog pre-warm done")),
    buildAtoonCatalog().then(() => logger.info("Atoon catalog pre-warm done")),
  ]).catch(() => {});
});
