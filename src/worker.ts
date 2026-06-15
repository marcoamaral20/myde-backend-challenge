import { Worker } from "bullmq";
import { db, closeDb } from "./infra/db/index.js";
import { KnowledgeBaseService } from "./infra/knowledge-base/knowledge-base-service.js";
import { MetaClient } from "./infra/meta/meta-client.js";
import {
  parseRedisConnection,
  PROCESS_INBOUND_MESSAGE_QUEUE,
  type ProcessInboundMessageJob,
} from "./infra/queue/message-queue.js";
import {
  PROCESS_INBOUND_MESSAGE_ATTEMPTS,
  PROCESS_INBOUND_MESSAGE_JOB_TIMEOUT_MS,
  PROCESS_INBOUND_MESSAGE_WORKER_CONCURRENCY,
} from "./infra/queue/message-queue-config.js";
import { createAIProvider } from "./modules/ai/index.js";
import { ProcessInboundMessageUseCase } from "./modules/messages/process-inbound-message-use-case.js";
import { env } from "./shared/env/index.js";
import { logger } from "./shared/logger/index.js";

const processor = new ProcessInboundMessageUseCase(
  db,
  createAIProvider(),
  new KnowledgeBaseService(),
  new MetaClient(),
);

const withJobTimeout = async <T>(promise: Promise<T>, timeoutMs: number) => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Job processing timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const worker = new Worker<ProcessInboundMessageJob>(
  PROCESS_INBOUND_MESSAGE_QUEUE,
  async (job) => {
    await withJobTimeout(
      processor.execute(job.data, { jobId: job.id }),
      PROCESS_INBOUND_MESSAGE_JOB_TIMEOUT_MS,
    );
  },
  {
    connection: parseRedisConnection(env.REDIS_URL),
    concurrency: PROCESS_INBOUND_MESSAGE_WORKER_CONCURRENCY,
  },
);

worker.on("failed", (job, error) => {
  if (!job) {
    logger.error({
      event: "worker_failed",
      error: error.message,
    });
    return;
  }

  const log = logger.child({
    tenantId: job.data.tenantId,
    conversationId: job.data.conversationId,
    messageId: job.data.messageId,
    jobId: job.id,
    correlationId: job.data.correlationId,
  });

  if (job.attemptsMade < PROCESS_INBOUND_MESSAGE_ATTEMPTS) {
    log.warn({
      event: "worker_retrying",
      attemptsMade: job.attemptsMade,
      attemptsAllowed: PROCESS_INBOUND_MESSAGE_ATTEMPTS,
      error: error.message,
    });
    return;
  }

  processor
    .markFinalFailure(job.data, error, { jobId: job.id })
    .then(() => {
      log.error({
        event: "worker_failed",
        attemptsMade: job.attemptsMade,
        attemptsAllowed: PROCESS_INBOUND_MESSAGE_ATTEMPTS,
        error: error.message,
      });
    })
    .catch((failureUpdateError: unknown) => {
      log.error({
        event: "worker_failed_status_update_failed",
        error:
          failureUpdateError instanceof Error
            ? failureUpdateError.message
            : "Unknown error",
      });
    });
});

await worker.waitUntilReady();

logger.info({
  event: "worker_started",
  redisUrlConfigured: Boolean(env.REDIS_URL),
  queueName: PROCESS_INBOUND_MESSAGE_QUEUE,
  concurrency: PROCESS_INBOUND_MESSAGE_WORKER_CONCURRENCY,
  jobTimeoutMs: PROCESS_INBOUND_MESSAGE_JOB_TIMEOUT_MS,
});

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info({ event: "worker_shutdown_started", signal });
  await worker.close();
  await closeDb();
  logger.info({ event: "worker_shutdown_completed", signal });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
