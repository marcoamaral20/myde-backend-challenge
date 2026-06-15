import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./shared/env/index.js";

export const buildHttpApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: {
        service: "myde-backend-challenge",
        environment: env.NODE_ENV,
      },
    },
  });

  return app;
};
