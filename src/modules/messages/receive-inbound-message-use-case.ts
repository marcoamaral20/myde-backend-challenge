import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../infra/db/schema.js";
import {
  contacts,
  conversations,
  messages,
  tenants,
} from "../../infra/db/schema.js";

export type ReceiveInboundMessageInput = {
  phoneNumberId: string;
  metaMessageId: string;
  from: string;
  contactName?: string;
  text: string;
  receivedAt?: Date;
  rawPayload: unknown;
};

export type ReceiveInboundMessageResult =
  | {
      status: "created";
      tenantId: string;
      contactId: string;
      conversationId: string;
      messageId: string;
      metaMessageId: string;
    }
  | {
      status: "duplicated";
      tenantId: string;
      contactId: string;
      conversationId: string;
      messageId: string;
      metaMessageId: string;
      processingStatus: string;
      shouldRetryProcessing: boolean;
    }
  | {
      status: "unknown_tenant";
      phoneNumberId: string;
      metaMessageId: string;
    };

export class ReceiveInboundMessageUseCase {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async execute(
    input: ReceiveInboundMessageInput,
  ): Promise<ReceiveInboundMessageResult> {
    const [tenant] = await this.database
      .select()
      .from(tenants)
      .where(eq(tenants.phoneNumberId, input.phoneNumberId))
      .limit(1);

    if (!tenant) {
      return {
        status: "unknown_tenant",
        phoneNumberId: input.phoneNumberId,
        metaMessageId: input.metaMessageId,
      };
    }

    return this.database.transaction(async (tx) => {
      const existingMessage = await findMessageByMetaId(
        tx,
        tenant.id,
        input.metaMessageId,
      );

      if (existingMessage) {
        return toDuplicatedResult(tenant.id, existingMessage);
      }

      const contact = await upsertContact(tx, {
        tenantId: tenant.id,
        waId: input.from,
        name: input.contactName,
      });

      const conversation = await findOrCreateActiveConversation(tx, {
        tenantId: tenant.id,
        contactId: contact.id,
      });

      const [message] = await tx
        .insert(messages)
        .values({
          tenantId: tenant.id,
          conversationId: conversation.id,
          contactId: contact.id,
          metaMessageId: input.metaMessageId,
          direction: "inbound",
          role: "user",
          content: input.text,
          processingStatus: "received",
          rawPayload: input.rawPayload,
          receivedAt: input.receivedAt ?? new Date(),
        })
        .onConflictDoNothing({
          target: [messages.tenantId, messages.metaMessageId],
          where: sql`${messages.metaMessageId} is not null`,
        })
        .returning();

      if (!message) {
        const duplicatedMessage = await findMessageByMetaId(
          tx,
          tenant.id,
          input.metaMessageId,
        );

        if (!duplicatedMessage) {
          throw new Error("Inbound message conflict could not be resolved");
        }

        return toDuplicatedResult(tenant.id, duplicatedMessage);
      }

      return {
        status: "created",
        tenantId: tenant.id,
        contactId: contact.id,
        conversationId: conversation.id,
        messageId: message.id,
        metaMessageId: input.metaMessageId,
      };
    });
  }
}

type Transaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

const findMessageByMetaId = async (
  tx: Transaction,
  tenantId: string,
  metaMessageId: string,
) => {
  const [message] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.metaMessageId, metaMessageId),
      ),
    )
    .limit(1);

  return message;
};

const upsertContact = async (
  tx: Transaction,
  input: {
    tenantId: string;
    waId: string;
    name?: string;
  },
) => {
  const updateSet = input.name
    ? {
        name: input.name,
        updatedAt: new Date(),
      }
    : {
        updatedAt: new Date(),
      };

  const [contact] = await tx
    .insert(contacts)
    .values({
      tenantId: input.tenantId,
      waId: input.waId,
      name: input.name,
    })
    .onConflictDoUpdate({
      target: [contacts.tenantId, contacts.waId],
      set: updateSet,
    })
    .returning();

  return contact;
};

const findOrCreateActiveConversation = async (
  tx: Transaction,
  input: {
    tenantId: string;
    contactId: string;
  },
) => {
  const [existingConversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, input.tenantId),
        eq(conversations.contactId, input.contactId),
        eq(conversations.status, "active"),
      ),
    )
    .limit(1);

  if (existingConversation) {
    return existingConversation;
  }

  const [conversation] = await tx
    .insert(conversations)
    .values({
      tenantId: input.tenantId,
      contactId: input.contactId,
      status: "active",
    })
    .onConflictDoNothing({
      target: [conversations.tenantId, conversations.contactId],
      where: sql`${conversations.status} = 'active'`,
    })
    .returning();

  if (conversation) {
    return conversation;
  }

  const [createdByConcurrentRequest] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, input.tenantId),
        eq(conversations.contactId, input.contactId),
        eq(conversations.status, "active"),
      ),
    )
    .limit(1);

  if (!createdByConcurrentRequest) {
    throw new Error("Active conversation conflict could not be resolved");
  }

  return createdByConcurrentRequest;
};

const toDuplicatedResult = (
  tenantId: string,
  message: schema.Message,
): ReceiveInboundMessageResult => ({
  status: "duplicated",
  tenantId,
  contactId: message.contactId,
  conversationId: message.conversationId,
  messageId: message.id,
  metaMessageId: message.metaMessageId ?? "",
  processingStatus: message.processingStatus,
  shouldRetryProcessing: ["received", "failed"].includes(
    message.processingStatus,
  ),
});
