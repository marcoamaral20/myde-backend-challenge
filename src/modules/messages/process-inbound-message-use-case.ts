import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, messages, tenants } from "../../infra/db/schema.js";
import type * as schema from "../../infra/db/schema.js";
import type { KnowledgeBaseService } from "../../infra/knowledge-base/knowledge-base-service.js";
import type { MetaClient } from "../../infra/meta/meta-client.js";
import type { ProcessInboundMessageJob } from "../../infra/queue/message-queue.js";
import type { AIProvider, ConversationHistoryMessage } from "../ai/index.js";
import { createLogger } from "../../shared/logger/index.js";

const conversationHistoryLimit = 8;

export type ProcessInboundMessageExecutionContext = {
  jobId?: string;
};

export class ProcessInboundMessageUseCase {
  constructor(
    private readonly database: NodePgDatabase<typeof schema>,
    private readonly aiProvider: AIProvider,
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly metaClient: MetaClient,
  ) {}

  async execute(
    input: ProcessInboundMessageJob,
    context: ProcessInboundMessageExecutionContext = {},
  ): Promise<void> {
    const log = createLogger({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      jobId: context.jobId,
      correlationId: input.correlationId,
    });

    log.info({ event: "worker_started" });

    const inbound = await this.findInboundMessage(input);

    if (!inbound) {
      throw new Error("Inbound message was not found for worker job");
    }

    const alreadyPersistedOutbound = await this.findOutboundReply(input);

    if (alreadyPersistedOutbound?.processingStatus === "sent") {
      await this.markInboundSent(input.messageId, input.tenantId);
      log.info({
        event: "message_processing_completed",
        replyToMessageId: input.messageId,
        outboundMessageId: alreadyPersistedOutbound.id,
        idempotencyResult: "outbound_already_sent",
      });
      return;
    }

    if (
      alreadyPersistedOutbound?.processingStatus === "sending" ||
      alreadyPersistedOutbound?.processingStatus === "failed"
    ) {
      // Without a Meta idempotency key or transactional outbox, retrying this
      // state could duplicate a WhatsApp message. Prefer manual inspection.
      const error = new Error(
        `Outbound reply ${alreadyPersistedOutbound.id} is in ${alreadyPersistedOutbound.processingStatus}; previous send may have been accepted`,
      );

      log.warn({
        event: "outbound_send_state_ambiguous",
        outboundMessageId: alreadyPersistedOutbound.id,
        outboundProcessingStatus: alreadyPersistedOutbound.processingStatus,
        error: error.message,
      });

      throw error;
    }

    await this.markInboundProcessing(input.messageId, input.tenantId);

    const outbound =
      alreadyPersistedOutbound ??
      (await this.generateAndPersistOutbound(input, inbound));

    const sendingOutbound = await this.markOutboundSending({
      outboundMessageId: outbound.id,
      tenantId: input.tenantId,
      inboundMessageId: input.messageId,
    });

    const metaResult = await this.metaClient.sendTextMessage({
      phoneNumberId: inbound.phoneNumberId,
      to: inbound.contactWaId,
      text: sendingOutbound.content,
      tenantId: input.tenantId,
      inboundMessageId: input.messageId,
      outboundMessageId: sendingOutbound.id,
      jobId: context.jobId,
      correlationId: input.correlationId,
    });

    await this.markReplySent({
      inboundMessageId: input.messageId,
      outboundMessageId: sendingOutbound.id,
      tenantId: input.tenantId,
      metaMessageId: metaResult.metaMessageId,
    });

    log.info({
      event: "message_processing_completed",
      outboundMessageId: sendingOutbound.id,
    });
  }

  async markFinalFailure(
    input: ProcessInboundMessageJob,
    error: Error,
    context: ProcessInboundMessageExecutionContext = {},
  ) {
    const failureReason = context.jobId
      ? `[jobId=${context.jobId}] ${error.message}`
      : error.message;

    await this.database
      .update(messages)
      .set({
        processingStatus: "failed",
        failureReason,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.id, input.messageId),
        ),
      );

    await this.database
      .update(messages)
      .set({
        processingStatus: "failed",
        failureReason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.replyToMessageId, input.messageId),
          sql`${messages.sentAt} is null`,
        ),
      );
  }

  private async findInboundMessage(input: ProcessInboundMessageJob) {
    const [result] = await this.database
      .select({
        message: messages,
        contactWaId: contacts.waId,
        phoneNumberId: tenants.phoneNumberId,
      })
      .from(messages)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, messages.contactId),
          eq(contacts.tenantId, messages.tenantId),
        ),
      )
      .innerJoin(tenants, eq(tenants.id, messages.tenantId))
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.conversationId, input.conversationId),
          eq(messages.id, input.messageId),
          eq(messages.direction, "inbound"),
        ),
      )
      .limit(1);

    if (!result) {
      return undefined;
    }

    return {
      ...result.message,
      contactWaId: result.contactWaId,
      phoneNumberId: result.phoneNumberId,
    };
  }

  private async findOutboundReply(input: ProcessInboundMessageJob) {
    const [outbound] = await this.database
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.conversationId, input.conversationId),
          eq(messages.direction, "outbound"),
          eq(messages.replyToMessageId, input.messageId),
        ),
      )
      .limit(1);

    return outbound;
  }

  private async generateAndPersistOutbound(
    input: ProcessInboundMessageJob,
    inbound: schema.Message & { contactWaId: string; phoneNumberId: string },
  ) {
    const log = createLogger({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      correlationId: input.correlationId,
    });
    const [history, knowledgeBase] = await Promise.all([
      this.loadConversationHistory(input),
      this.knowledgeBaseService.loadContext(),
    ]);

    let reply: string;

    try {
      reply = await this.aiProvider.generateReply({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        userMessage: inbound.content,
        history,
        knowledgeBase: knowledgeBase.content,
        promptRules: knowledgeBase.promptRules,
        correlationId: input.correlationId,
      });
    } catch (error) {
      log.warn({
        event: "ai_call_failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }

    log.info({ event: "ai_reply_generated" });

    const [createdOutbound] = await this.database
      .insert(messages)
      .values({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        contactId: inbound.contactId,
        metaMessageId: null,
        replyToMessageId: input.messageId,
        direction: "outbound",
        role: "assistant",
        content: reply,
        processingStatus: "reply_generated",
        processedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [messages.tenantId, messages.replyToMessageId],
        where: sql`${messages.replyToMessageId} is not null`,
      })
      .returning();

    const outbound =
      createdOutbound ??
      (await this.findOutboundReply({
        ...input,
        messageId: inbound.id,
      }));

    if (!outbound) {
      throw new Error("Outbound reply conflict could not be resolved");
    }

    await this.markInboundReplyGenerated(input.messageId, input.tenantId);

    return outbound;
  }

  private async loadConversationHistory(
    input: ProcessInboundMessageJob,
  ): Promise<ConversationHistoryMessage[]> {
    const rows = await this.database
      .select({
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.conversationId, input.conversationId),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(conversationHistoryLimit);

    return rows
      .reverse()
      .filter(
        (message): message is ConversationHistoryMessage =>
          message.role === "user" || message.role === "assistant",
      );
  }

  private async markInboundProcessing(messageId: string, tenantId: string) {
    await this.database
      .update(messages)
      .set({
        processingStatus: "processing",
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)));
  }

  private async markInboundReplyGenerated(messageId: string, tenantId: string) {
    await this.database
      .update(messages)
      .set({
        processingStatus: "reply_generated",
        processedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)));
  }

  private async markOutboundSending(input: {
    outboundMessageId: string;
    tenantId: string;
    inboundMessageId: string;
  }) {
    const [outbound] = await this.database
      .update(messages)
      .set({
        processingStatus: "sending",
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.id, input.outboundMessageId),
          eq(messages.tenantId, input.tenantId),
          eq(messages.replyToMessageId, input.inboundMessageId),
          eq(messages.processingStatus, "reply_generated"),
        ),
      )
      .returning();

    if (!outbound) {
      throw new Error(
        `Outbound reply ${input.outboundMessageId} could not be marked as sending`,
      );
    }

    return outbound;
  }

  private async markReplySent(input: {
    inboundMessageId: string;
    outboundMessageId: string;
    tenantId: string;
    metaMessageId: string | null;
  }) {
    const now = new Date();

    await this.database.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          metaMessageId: input.metaMessageId,
          processingStatus: "sent",
          sentAt: now,
          failureReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(messages.id, input.outboundMessageId),
            eq(messages.tenantId, input.tenantId),
          ),
        );

      await tx
        .update(messages)
        .set({
          processingStatus: "sent",
          processedAt: now,
          sentAt: now,
          failureReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(messages.id, input.inboundMessageId),
            eq(messages.tenantId, input.tenantId),
          ),
        );
    });
  }

  private async markInboundSent(messageId: string, tenantId: string) {
    const now = new Date();

    await this.database
      .update(messages)
      .set({
        processingStatus: "sent",
        processedAt: now,
        sentAt: now,
        failureReason: null,
        updatedAt: now,
      })
      .where(and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)));
  }
}
