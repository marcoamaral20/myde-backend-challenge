import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { ConversationRepository } from "../src/modules/conversations/conversation-repository.js";
import { ConversationService } from "../src/modules/conversations/conversation-service.js";
import { ReceiveInboundMessageUseCase } from "../src/modules/messages/receive-inbound-message-use-case.js";
import {
  conversations,
  messages,
  tenants,
} from "../src/infra/db/schema.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "./helpers/test-db.js";

const runId = `vitest-${Date.now()}-${randomUUID().slice(0, 8)}`;

describe("mandatory business rules", () => {
  let testDatabase: TestDatabase;
  let receiveInboundMessageUseCase: ReceiveInboundMessageUseCase;
  let conversationService: ConversationService;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    receiveInboundMessageUseCase = new ReceiveInboundMessageUseCase(
      testDatabase.db,
    );
    conversationService = new ConversationService(
      new ConversationRepository(testDatabase.db),
    );
  });

  afterAll(async () => {
    if (testDatabase) {
      await testDatabase.db
        .delete(tenants)
        .where(like(tenants.phoneNumberId, `${runId}-%`));
      await testDatabase.close();
    }
  });

  it("does not duplicate messages for a repeated metaMessageId", async () => {
    const tenant = await createTenant("idempotency");
    const metaMessageId = `${runId}-meta-idempotent`;

    const firstResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenant.phoneNumberId,
      metaMessageId,
      from: "5511999990001",
      contactName: "Ada",
      text: "Oi",
      receivedAt: new Date("2026-06-15T12:00:00.000Z"),
      rawPayload: { test: "first-delivery" },
    });

    const repeatedResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenant.phoneNumberId,
      metaMessageId,
      from: "5511999990001",
      contactName: "Ada",
      text: "Oi de novo",
      receivedAt: new Date("2026-06-15T12:01:00.000Z"),
      rawPayload: { test: "redelivery" },
    });

    const [{ count }] = await testDatabase.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        sql`${messages.tenantId} = ${tenant.id} and ${messages.metaMessageId} = ${metaMessageId}`,
      );

    expect(firstResult.status).toBe("created");
    expect(repeatedResult.status).toBe("duplicated");
    expect(repeatedResult.messageId).toBe(firstResult.messageId);
    expect(count).toBe(1);
  });

  it("creates or reuses the active conversation for the same contact", async () => {
    const tenant = await createTenant("conversation-reuse");
    const from = "5511999990002";

    const firstResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenant.phoneNumberId,
      metaMessageId: `${runId}-meta-conversation-1`,
      from,
      contactName: "Grace",
      text: "Primeira mensagem",
      rawPayload: { test: "first-message" },
    });

    const secondResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenant.phoneNumberId,
      metaMessageId: `${runId}-meta-conversation-2`,
      from,
      contactName: "Grace Hopper",
      text: "Segunda mensagem",
      rawPayload: { test: "second-message" },
    });

    const [{ count }] = await testDatabase.db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.tenantId, tenant.id));

    expect(firstResult.status).toBe("created");
    expect(secondResult.status).toBe("created");
    expect(secondResult.conversationId).toBe(firstResult.conversationId);
    expect(count).toBe(1);
  });

  it("prevents tenant A from reading tenant B conversation messages", async () => {
    const tenantA = await createTenant("tenant-a");
    const tenantB = await createTenant("tenant-b");

    const tenantAResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenantA.phoneNumberId,
      metaMessageId: `${runId}-meta-tenant-a`,
      from: "5511999990003",
      text: "Mensagem do tenant A",
      rawPayload: { test: "tenant-a" },
    });

    const tenantBResult = await receiveInboundMessageUseCase.execute({
      phoneNumberId: tenantB.phoneNumberId,
      metaMessageId: `${runId}-meta-tenant-b`,
      from: "5511999990004",
      text: "Mensagem do tenant B",
      rawPayload: { test: "tenant-b" },
    });

    if (
      tenantAResult.status !== "created" ||
      tenantBResult.status !== "created"
    ) {
      throw new Error("Expected tenant setup messages to be created");
    }

    const tenantAConversations = await conversationService.listConversations({
      tenantId: tenantA.id,
      limit: 50,
      offset: 0,
    });
    const tenantAMessagesForTenantBConversation =
      await conversationService.listConversationMessages({
        tenantId: tenantA.id,
        conversationId: tenantBResult.conversationId,
        limit: 50,
        offset: 0,
      });

    expect(tenantAConversations.map((conversation) => conversation.id)).toContain(
      tenantAResult.conversationId,
    );
    expect(
      tenantAConversations.map((conversation) => conversation.id),
    ).not.toContain(tenantBResult.conversationId);
    expect(tenantAMessagesForTenantBConversation).toBeNull();
  });

  const createTenant = async (name: string) => {
    const [tenant] = await testDatabase.db
      .insert(tenants)
      .values({
        name: `Test ${name} ${runId}`,
        phoneNumberId: `${runId}-${name}`,
      })
      .returning();

    return tenant;
  };
});
