import pino from "pino";
import { env } from "../env/index.js";

export type LogContext = {
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
  metaMessageId?: string;
  replyToMessageId?: string;
  jobId?: string;
  correlationId?: string;
  event?: string;
};

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "myde-backend-challenge",
    environment: env.NODE_ENV,
  },
});

export const createLogger = (context: LogContext) => logger.child(context);
