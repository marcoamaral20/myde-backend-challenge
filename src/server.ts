import { buildHttpApp } from "./app.js";
import { env } from "./shared/env/index.js";
import { logger } from "./shared/logger/index.js";

const app = await buildHttpApp();

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info({ event: "http_shutdown_started", signal });
  await app.close();
  logger.info({ event: "http_shutdown_completed", signal });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: "0.0.0.0", port: env.PORT });
