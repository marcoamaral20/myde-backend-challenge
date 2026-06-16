import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { AIProvider, GenerateReplyInput } from "../src/modules/ai/index.js";
import type { KnowledgeBaseService } from "../src/infra/knowledge-base/knowledge-base-service.js";
import type {
  MetaClient,
  SendTextMessageInput,
  SendTextMessageResult,
} from "../src/infra/meta/meta-client.js";
import type { ProcessInboundMessageJob } from "../src/infra/queue/message-queue.js";
import { ProcessInboundMessageUseCase } from "../src/modules/messages/process-inbound-message-use-case.js";
import {
  contacts,
  conversations,
  messages,
  tenants,
} from "../src/infra/db/schema.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "./helpers/test-db.js";

const runId = `vitest-worker-${Date.now()}-${randomUUID().slice(0, 8)}`;

describe("ProcessInboundMessageUseCase worker idempotency", () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
  });

  afterAll(async () => {
    if (testDatabase) {
      await testDatabase.db
        .delete(tenants)
        .where(like(tenants.phoneNumberId, `${runId}-%`));
      await testDatabase.close();
    }
  });

  it("does not create a duplicate outbound reply when a retry sees an ambiguous sending state", async () => {
    const setup = await createInboundMessage("retry-no-duplicate");
    const aiProvider = new FakeAIProvider("Resposta gerada uma vez");
    const metaClient = new FakeMetaClient({
      error: new Error("Meta API unavailable"),
    });
    const processor = createProcessor(aiProvider, metaClient);

    await expect(processor.execute(setup.job)).rejects.toThrow(
      "Meta API unavailable",
    );
    await expect(processor.execute(setup.job)).rejects.toThrow(
      "previous send may have been accepted",
    );

    const outboundMessages = await findOutboundReplies(setup);

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.processingStatus).toBe("sending");
    expect(aiProvider.calls).toHaveLength(1);
    expect(metaClient.calls).toHaveLength(1);
  });

  it("reuses an existing pending outbound reply instead of generating another one", async () => {
    const setup = await createInboundMessage("reuse-pending-outbound");
    const existingOutbound = await createOutboundReply(setup, {
      content: "Resposta pendente existente",
      processingStatus: "reply_generated",
    });
    const aiProvider = new FakeAIProvider("Nova resposta que nao deve ser usada");
    const metaClient = new FakeMetaClient({
      metaMessageId: `${runId}-meta-outbound-reused`,
    });
    const processor = createProcessor(aiProvider, metaClient);

    await processor.execute(setup.job);

    const outboundMessages = await findOutboundReplies(setup);
    const [inbound] = await testDatabase.db
      .select()
      .from(messages)
      .where(eq(messages.id, setup.message.id))
      .limit(1);

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.id).toBe(existingOutbound.id);
    expect(outboundMessages[0]?.content).toBe("Resposta pendente existente");
    expect(outboundMessages[0]?.processingStatus).toBe("sent");
    expect(inbound?.processingStatus).toBe("sent");
    expect(aiProvider.calls).toHaveLength(0);
    expect(metaClient.calls).toHaveLength(1);
    expect(metaClient.calls[0]?.text).toBe("Resposta pendente existente");
  });

  it("does not resend an outbound reply that was already sent", async () => {
    const setup = await createInboundMessage("already-sent");
    await createOutboundReply(setup, {
      content: "Resposta ja enviada",
      processingStatus: "sent",
      metaMessageId: `${runId}-already-sent-meta`,
      sentAt: new Date("2026-06-15T13:00:00.000Z"),
    });
    const aiProvider = new FakeAIProvider("Nova resposta bloqueada");
    const metaClient = new FakeMetaClient({
      metaMessageId: `${runId}-should-not-send`,
    });
    const processor = createProcessor(aiProvider, metaClient);

    await processor.execute(setup.job);

    const outboundMessages = await findOutboundReplies(setup);
    const [inbound] = await testDatabase.db
      .select()
      .from(messages)
      .where(eq(messages.id, setup.message.id))
      .limit(1);

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.processingStatus).toBe("sent");
    expect(inbound?.processingStatus).toBe("sent");
    expect(aiProvider.calls).toHaveLength(0);
    expect(metaClient.calls).toHaveLength(0);
  });

  it("raises MetaClient failures so BullMQ can retry the job", async () => {
    const setup = await createInboundMessage("meta-failure");
    const aiProvider = new FakeAIProvider("Resposta antes da falha");
    const metaClient = new FakeMetaClient({
      error: new Error("Meta send failed"),
    });
    const processor = createProcessor(aiProvider, metaClient);

    await expect(processor.execute(setup.job)).rejects.toThrow(
      "Meta send failed",
    );

    const outboundMessages = await findOutboundReplies(setup);

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.processingStatus).toBe("sending");
    expect(metaClient.calls).toHaveLength(1);
  });

  it("does not automatically resend an outbound reply in an ambiguous sending state", async () => {
    const setup = await createInboundMessage("ambiguous-sending");
    await createOutboundReply(setup, {
      content: "Envio possivelmente aceito",
      processingStatus: "sending",
    });
    const aiProvider = new FakeAIProvider("Resposta bloqueada");
    const metaClient = new FakeMetaClient({
      metaMessageId: `${runId}-ambiguous-should-not-send`,
    });
    const processor = createProcessor(aiProvider, metaClient);

    await expect(processor.execute(setup.job)).rejects.toThrow(
      "previous send may have been accepted",
    );

    const outboundMessages = await findOutboundReplies(setup);

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0]?.processingStatus).toBe("sending");
    expect(aiProvider.calls).toHaveLength(0);
    expect(metaClient.calls).toHaveLength(0);
  });

  const createProcessor = (
    aiProvider: AIProvider,
    metaClient: FakeMetaClient,
  ) =>
    new ProcessInboundMessageUseCase(
      testDatabase.db,
      aiProvider,
      new FakeKnowledgeBaseService() as unknown as KnowledgeBaseService,
      metaClient as unknown as MetaClient,
    );

  const createInboundMessage = async (name: string) => {
    const [tenant] = await testDatabase.db
      .insert(tenants)
      .values({
        name: `Worker Test ${name} ${runId}`,
        phoneNumberId: `${runId}-${name}`,
      })
      .returning();

    const [contact] = await testDatabase.db
      .insert(contacts)
      .values({
        tenantId: tenant.id,
        waId: `5511999${randomUUID().slice(0, 8)}`,
        name: `Contact ${name}`,
      })
      .returning();

    const [conversation] = await testDatabase.db
      .insert(conversations)
      .values({
        tenantId: tenant.id,
        contactId: contact.id,
        status: "active",
      })
      .returning();

    const [message] = await testDatabase.db
      .insert(messages)
      .values({
        tenantId: tenant.id,
        conversationId: conversation.id,
        contactId: contact.id,
        metaMessageId: `${runId}-${name}-inbound`,
        direction: "inbound",
        role: "user",
        content: "Preciso de ajuda",
        processingStatus: "queued",
        rawPayload: { test: name },
        receivedAt: new Date("2026-06-15T12:00:00.000Z"),
      })
      .returning();

    return {
      tenant,
      contact,
      conversation,
      message,
      job: {
        tenantId: tenant.id,
        conversationId: conversation.id,
        messageId: message.id,
        correlationId: `${runId}-${name}-correlation`,
      } satisfies ProcessInboundMessageJob,
    };
  };

  const createOutboundReply = async (
    setup: Awaited<ReturnType<typeof createInboundMessage>>,
    input: {
      content: string;
      processingStatus: "reply_generated" | "sending" | "sent" | "failed";
      metaMessageId?: string;
      sentAt?: Date;
    },
  ) => {
    const [outbound] = await testDatabase.db
      .insert(messages)
      .values({
        tenantId: setup.tenant.id,
        conversationId: setup.conversation.id,
        contactId: setup.contact.id,
        metaMessageId: input.metaMessageId ?? null,
        replyToMessageId: setup.message.id,
        direction: "outbound",
        role: "assistant",
        content: input.content,
        processingStatus: input.processingStatus,
        processedAt: new Date("2026-06-15T12:05:00.000Z"),
        sentAt: input.sentAt,
      })
      .returning();

    return outbound;
  };

  const findOutboundReplies = async (
    setup: Awaited<ReturnType<typeof createInboundMessage>>,
  ) =>
    testDatabase.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, setup.tenant.id),
          eq(messages.conversationId, setup.conversation.id),
          eq(messages.direction, "outbound"),
          eq(messages.replyToMessageId, setup.message.id),
        ),
      );
});

class FakeAIProvider implements AIProvider {
  readonly calls: GenerateReplyInput[] = [];

  constructor(private readonly reply: string) {}

  async generateReply(input: GenerateReplyInput): Promise<string> {
    this.calls.push(input);
    return this.reply;
  }
}

class FakeKnowledgeBaseService {
  async loadContext() {
    return {
      content: "Planos e suporte disponiveis para clientes Myde.",
      promptRules: ["Responda apenas com base na base de conhecimento."],
    };
  }
}

class FakeMetaClient {
  readonly calls: SendTextMessageInput[] = [];

  constructor(
    private readonly result: { metaMessageId?: string; error?: Error },
  ) {}

  async sendTextMessage(
    input: SendTextMessageInput,
  ): Promise<SendTextMessageResult> {
    this.calls.push(input);

    if (this.result.error) {
      throw this.result.error;
    }

    return {
      metaMessageId: this.result.metaMessageId ?? null,
    };
  }
}
