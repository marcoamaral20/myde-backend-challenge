import { sql } from "drizzle-orm";
import {
  index,
  check,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const conversationStatus = pgEnum("conversation_status", [
  "active",
  "closed",
]);

export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

export const processingStatus = pgEnum("processing_status", [
  "received",
  "queued",
  "processing",
  "reply_generated",
  "sent",
  "failed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    ...timestamps,
  },
  (table) => ({
    phoneNumberIdUnique: uniqueIndex("tenants_phone_number_id_unique").on(
      table.phoneNumberId,
    ),
  }),
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    waId: text("wa_id").notNull(),
    name: text("name"),
    ...timestamps,
  },
  (table) => ({
    tenantWaIdUnique: uniqueIndex("contacts_tenant_id_wa_id_unique").on(
      table.tenantId,
      table.waId,
    ),
    tenantIdIdx: index("contacts_tenant_id_idx").on(table.tenantId),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: conversationStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => ({
    tenantIdIdx: index("conversations_tenant_id_idx").on(table.tenantId),
    contactIdIdx: index("conversations_contact_id_idx").on(table.contactId),
    activeConversationUnique: uniqueIndex(
      "conversations_active_contact_unique",
    )
      .on(table.tenantId, table.contactId)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    metaMessageId: text("meta_message_id"),
    replyToMessageId: uuid("reply_to_message_id"),
    direction: messageDirection("direction").notNull(),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    processingStatus: processingStatus("processing_status").notNull(),
    failureReason: text("failure_reason"),
    // rawPayload can help debug webhook issues, but it may contain PII.
    rawPayload: jsonb("raw_payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    tenantIdIdx: index("messages_tenant_id_idx").on(table.tenantId),
    conversationIdIdx: index("messages_conversation_id_idx").on(
      table.conversationId,
    ),
    contactIdIdx: index("messages_contact_id_idx").on(table.contactId),
    tenantMetaMessageIdUnique: uniqueIndex(
      "messages_tenant_id_meta_message_id_unique",
    )
      .on(table.tenantId, table.metaMessageId)
      .where(sql`${table.metaMessageId} is not null`),
    tenantReplyToMessageIdUnique: uniqueIndex(
      "messages_tenant_id_reply_to_message_id_unique",
    )
      .on(table.tenantId, table.replyToMessageId)
      .where(sql`${table.replyToMessageId} is not null`),
    inboundMetaMessageIdRequired: check(
      "messages_inbound_meta_message_id_required",
      sql`${table.direction} <> 'inbound' OR ${table.metaMessageId} IS NOT NULL`,
    ),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
