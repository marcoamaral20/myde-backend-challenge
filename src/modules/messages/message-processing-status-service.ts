import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { messages } from "../../infra/db/schema.js";
import type * as schema from "../../infra/db/schema.js";

export class MessageProcessingStatusService {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async markQueued(input: { tenantId: string; messageId: string }) {
    const [updatedMessage] = await this.database
      .update(messages)
      .set({
        processingStatus: "queued",
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.id, input.messageId),
          inArray(messages.processingStatus, ["received", "failed"]),
        ),
      )
      .returning({ id: messages.id });

    if (!updatedMessage) {
      throw new Error(
        `Message ${input.messageId} could not be marked as queued`,
      );
    }
  }
}
