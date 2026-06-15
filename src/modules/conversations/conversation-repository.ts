import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  contacts,
  conversations,
  messages,
} from "../../infra/db/schema.js";
import type * as schema from "../../infra/db/schema.js";

export type ConversationListItem = {
  id: string;
  contact: {
    id: string;
    waId: string;
    name: string | null;
  };
  status: "active" | "closed";
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationMessageListItem = {
  id: string;
  direction: "inbound" | "outbound";
  role: "user" | "assistant" | "system";
  content: string;
  processingStatus:
    | "received"
    | "queued"
    | "processing"
    | "reply_generated"
    | "sending"
    | "sent"
    | "failed";
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
};

export class ConversationRepository {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async listByTenant(input: {
    tenantId: string;
    limit: number;
    offset: number;
  }): Promise<ConversationListItem[]> {
    const rows = await this.database
      .select({
        id: conversations.id,
        status: conversations.status,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        contactId: contacts.id,
        contactWaId: contacts.waId,
        contactName: contacts.name,
      })
      .from(conversations)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, conversations.contactId),
          eq(contacts.tenantId, conversations.tenantId),
        ),
      )
      .where(eq(conversations.tenantId, input.tenantId))
      .orderBy(
        desc(conversations.updatedAt),
        desc(conversations.createdAt),
        asc(conversations.id),
      )
      .limit(input.limit)
      .offset(input.offset);

    return rows.map((row) => ({
      id: row.id,
      contact: {
        id: row.contactId,
        waId: row.contactWaId,
        name: row.contactName,
      },
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async existsForTenant(input: {
    tenantId: string;
    conversationId: string;
  }): Promise<boolean> {
    const [conversation] = await this.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.id, input.conversationId),
        ),
      )
      .limit(1);

    return Boolean(conversation);
  }

  async listMessagesByConversation(input: {
    tenantId: string;
    conversationId: string;
    limit: number;
    offset: number;
  }): Promise<ConversationMessageListItem[]> {
    return this.database
      .select({
        id: messages.id,
        direction: messages.direction,
        role: messages.role,
        content: messages.content,
        processingStatus: messages.processingStatus,
        receivedAt: messages.receivedAt,
        sentAt: messages.sentAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.conversationId, input.conversationId),
        ),
      )
      .orderBy(asc(messages.receivedAt), asc(messages.createdAt), asc(messages.id))
      .limit(input.limit)
      .offset(input.offset);
  }
}
