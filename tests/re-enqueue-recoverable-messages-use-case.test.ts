import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import type {
  MessageQueue,
  ProcessInboundMessageJob,
} from "../src/infra/queue/message-queue.js";
import { ReEnqueueRecoverableMessagesUseCase } from "../src/modules/messages/re-enqueue-recoverable-messages-use-case.js";
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

const runId = `vitest-reenqueue-${Date.now()}-${randomUUID().slice(0, 8)}`;

describe("ReEnqueueRecoverableMessagesUseCase", () => {
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

  it("re-enqueues only inbound messages in received or failed status", async () => {
    const setup = await createConversation();
    const received = await createInboundMessage(setup, "received");
    const failed = await createInboundMessage(setup, "failed");
    const queued = await createInboundMessage(setup, "queued");
    const processing = await createInboundMessage(setup, "processing");
    const replyGenerated = await createInboundMessage(setup, "reply_generated");
    const sending = await createInboundMessage(setup, "sending");
    const sent = await createInboundMessage(setup, "sent");
    const outboundFailed = await createOutboundMessage(setup, "failed");
    const queue = new FakeMessageQueue();
    const result = await new ReEnqueueRecoverableMessagesUseCase(
      testDatabase.db,
      queue,
    ).execute();

    const rows = await testDatabase.db
      .select({
        id: messages.id,
        processingStatus: messages.processingStatus,
      })
      .from(messages)
      .where(
        inArray(messages.id, [
          received.id,
          failed.id,
          queued.id,
          processing.id,
          replyGenerated.id,
          sending.id,
          sent.id,
          outboundFailed.id,
        ]),
      );
    const statusesById = new Map(
      rows.map((message) => [message.id, message.processingStatus]),
    );

    expect(result.eligible).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(result.failures).toEqual([]);
    expect(queue.jobs.map((job) => job.messageId).sort()).toEqual(
      [failed.id, received.id].sort(),
    );
    expect(statusesById.get(received.id)).toBe("queued");
    expect(statusesById.get(failed.id)).toBe("queued");
    expect(statusesById.get(queued.id)).toBe("queued");
    expect(statusesById.get(processing.id)).toBe("processing");
    expect(statusesById.get(replyGenerated.id)).toBe("reply_generated");
    expect(statusesById.get(sending.id)).toBe("sending");
    expect(statusesById.get(sent.id)).toBe("sent");
    expect(statusesById.get(outboundFailed.id)).toBe("failed");
  });

  const createConversation = async () => {
    const [tenant] = await testDatabase.db
      .insert(tenants)
      .values({
        name: `Reenqueue Test ${runId}`,
        phoneNumberId: `${runId}-tenant`,
      })
      .returning();

    const [contact] = await testDatabase.db
      .insert(contacts)
      .values({
        tenantId: tenant.id,
        waId: `5511888${randomUUID().slice(0, 8)}`,
        name: "Recoverable Contact",
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

    return { tenant, contact, conversation };
  };

  const createInboundMessage = async (
    setup: Awaited<ReturnType<typeof createConversation>>,
    processingStatus:
      | "received"
      | "failed"
      | "queued"
      | "processing"
      | "reply_generated"
      | "sending"
      | "sent",
  ) => {
    const [message] = await testDatabase.db
      .insert(messages)
      .values({
        tenantId: setup.tenant.id,
        conversationId: setup.conversation.id,
        contactId: setup.contact.id,
        metaMessageId: `${runId}-${processingStatus}-${randomUUID()}`,
        direction: "inbound",
        role: "user",
        content: `Mensagem ${processingStatus}`,
        processingStatus,
        receivedAt: new Date("2026-06-15T12:00:00.000Z"),
      })
      .returning();

    return message;
  };

  const createOutboundMessage = async (
    setup: Awaited<ReturnType<typeof createConversation>>,
    processingStatus: "failed",
  ) => {
    const [message] = await testDatabase.db
      .insert(messages)
      .values({
        tenantId: setup.tenant.id,
        conversationId: setup.conversation.id,
        contactId: setup.contact.id,
        metaMessageId: null,
        replyToMessageId: null,
        direction: "outbound",
        role: "assistant",
        content: "Outbound failed must not be re-enqueued",
        processingStatus,
      })
      .returning();

    return message;
  };
});

class FakeMessageQueue implements MessageQueue {
  readonly jobs: ProcessInboundMessageJob[] = [];

  async enqueueProcessInboundMessage(job: ProcessInboundMessageJob) {
    this.jobs.push(job);
    return { jobId: `${job.tenantId}-${job.messageId}` };
  }

  async close() {}
}
