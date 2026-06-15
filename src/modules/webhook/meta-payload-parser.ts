import { z } from "zod";

const MetaPayloadSchema = z
  .object({
    entry: z
      .array(
        z.object({
          changes: z
            .array(
              z.object({
                value: z.object({
                  metadata: z
                    .object({
                      phone_number_id: z.string().optional(),
                    })
                    .optional(),
                  contacts: z
                    .array(
                      z.object({
                        wa_id: z.string().optional(),
                        profile: z
                          .object({
                            name: z.string().optional(),
                          })
                          .optional(),
                      }),
                    )
                    .optional(),
                  messages: z
                    .array(
                      z.object({
                        id: z.string().optional(),
                        from: z.string().optional(),
                        timestamp: z.string().optional(),
                        type: z.string().optional(),
                        text: z
                          .object({
                            body: z.string().optional(),
                          })
                          .optional(),
                      }),
                    )
                    .optional(),
                }),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type ParsedInboundMetaMessage = {
  phoneNumberId: string;
  messageId: string;
  from: string;
  contactName?: string;
  text: string;
  timestamp?: Date;
};

export type ParseMetaPayloadResult =
  | {
      kind: "messages";
      messages: ParsedInboundMetaMessage[];
    }
  | {
      kind: "ignored";
      reason: "invalid_payload" | "no_supported_messages";
    };

export const parseMetaWebhookPayload = (
  payload: unknown,
): ParseMetaPayloadResult => {
  const parsedPayload = MetaPayloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    return { kind: "ignored", reason: "invalid_payload" };
  }

  const messages: ParsedInboundMetaMessage[] = [];

  for (const entry of parsedPayload.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value.metadata?.phone_number_id;

      const normalizedPhoneNumberId = phoneNumberId?.trim();

      if (!normalizedPhoneNumberId) {
        continue;
      }

      const contactNamesByWaId = new Map<string, string>();

      for (const contact of change.value.contacts ?? []) {
        if (contact.wa_id && contact.profile?.name) {
          contactNamesByWaId.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const message of change.value.messages ?? []) {
        const messageId = message.id?.trim();
        const from = message.from?.trim();

        if (message.type !== "text" || !messageId || !from || !message.text?.body) {
          continue;
        }

        messages.push({
          phoneNumberId: normalizedPhoneNumberId,
          messageId,
          from,
          contactName: contactNamesByWaId.get(from),
          text: message.text.body,
          timestamp: parseMetaTimestamp(message.timestamp),
        });
      }
    }
  }

  if (messages.length === 0) {
    return { kind: "ignored", reason: "no_supported_messages" };
  }

  return { kind: "messages", messages };
};

const parseMetaTimestamp = (timestamp?: string) => {
  if (!timestamp) {
    return undefined;
  }

  const timestampMs = Number(timestamp) * 1000;

  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }

  return new Date(timestampMs);
};
