import { closeDb, db } from "./infra/db/index.js";
import { BullMqMessageQueue } from "./infra/queue/message-queue.js";
import { ReEnqueueRecoverableMessagesUseCase } from "./modules/messages/re-enqueue-recoverable-messages-use-case.js";
import { logger } from "./shared/logger/index.js";

const parseLimit = () => {
  const rawLimit = process.env.REENQUEUE_LIMIT;

  if (!rawLimit) {
    return undefined;
  }

  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("REENQUEUE_LIMIT must be a positive integer");
  }

  return limit;
};

const messageQueue = new BullMqMessageQueue();

try {
  const result = await new ReEnqueueRecoverableMessagesUseCase(
    db,
    messageQueue,
  ).execute({ limit: parseLimit() });

  logger.info({
    event: "recoverable_messages_reenqueue_completed",
    eligible: result.eligible,
    enqueued: result.enqueued,
    failureCount: result.failures.length,
    failures: result.failures,
  });

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await messageQueue.close();
  await closeDb();
}
