import { env } from "./shared/env/index.js";
import { logger } from "./shared/logger/index.js";

logger.info({
  event: "worker_entrypoint_ready",
  redisUrlConfigured: Boolean(env.REDIS_URL),
});

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info({ event: "worker_shutdown_completed", signal });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
