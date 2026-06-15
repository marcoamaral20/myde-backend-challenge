import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhookRoutes } from "./modules/webhook/webhook-routes.js";
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

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  await registerWebhookRoutes(app);

  return app;
};
