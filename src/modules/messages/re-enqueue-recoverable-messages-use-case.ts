import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { messages } from "../../infra/db/schema.js";
import type * as schema from "../../infra/db/schema.js";
import type { MessageQueue } from "../../infra/queue/message-queue.js";
import { createCorrelationId } from "../../shared/tracing/correlation-id.js";
import { MessageProcessingStatusService } from "./message-processing-status-service.js";

export type ReEnqueueRecoverableMessagesInput = {
  limit?: number;
};

export type ReEnqueueRecoverableMessagesResult = {
  eligible: number;
  enqueued: number;
  failures: Array<{
    tenantId: string;
    messageId: string;
    processingStatus: "received" | "failed";
    error: string;
  }>;
};

const recoverableStatuses = ["received", "failed"] as const;

export class ReEnqueueRecoverableMessagesUseCase {
  private readonly processingStatusService: MessageProcessingStatusService;

  constructor(
    private readonly database: NodePgDatabase<typeof schema>,
    private readonly messageQueue: MessageQueue,
  ) {
    this.processingStatusService = new MessageProcessingStatusService(database);
  }

  async execute(
    input: ReEnqueueRecoverableMessagesInput = {},
  ): Promise<ReEnqueueRecoverableMessagesResult> {
    const limit = input.limit ?? 100;
    const recoverableMessages = await this.database
      .select({
        id: messages.id,
        tenantId: messages.tenantId,
        conversationId: messages.conversationId,
        processingStatus: messages.processingStatus,
      })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "inbound"),
          inArray(messages.processingStatus, recoverableStatuses),
        ),
      )
      .orderBy(asc(messages.receivedAt), asc(messages.createdAt), asc(messages.id))
      .limit(limit);

    const result: ReEnqueueRecoverableMessagesResult = {
      eligible: recoverableMessages.length,
      enqueued: 0,
      failures: [],
    };

    for (const message of recoverableMessages) {
      const processingStatus = message.processingStatus as "received" | "failed";

      try {
        await this.messageQueue.enqueueProcessInboundMessage({
          tenantId: message.tenantId,
          conversationId: message.conversationId,
          messageId: message.id,
          correlationId: createCorrelationId(),
        });

        await this.processingStatusService.markQueued({
          tenantId: message.tenantId,
          messageId: message.id,
        });

        result.enqueued += 1;
      } catch (error) {
        result.failures.push({
          tenantId: message.tenantId,
          messageId: message.id,
          processingStatus,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return result;
  }
}
