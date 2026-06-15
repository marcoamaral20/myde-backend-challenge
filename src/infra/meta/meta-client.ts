import { env } from "../../shared/env/index.js";
import { createLogger } from "../../shared/logger/index.js";

export type SendTextMessageInput = {
  phoneNumberId: string;
  to: string;
  text: string;
  tenantId: string;
  inboundMessageId: string;
  outboundMessageId: string;
  jobId?: string;
  correlationId: string;
};

export type SendTextMessageResult = {
  metaMessageId: string | null;
};

export class MetaClient {
  constructor(
    private readonly baseUrl = env.META_API_BASE_URL,
    private readonly timeoutMs = 10_000,
  ) {}

  async sendTextMessage(
    input: SendTextMessageInput,
  ): Promise<SendTextMessageResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${input.phoneNumberId}/messages`;
    const log = createLogger({
      tenantId: input.tenantId,
      inboundMessageId: input.inboundMessageId,
      outboundMessageId: input.outboundMessageId,
      jobId: input.jobId,
      correlationId: input.correlationId,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: input.to,
          type: "text",
          text: {
            preview_url: false,
            body: input.text,
          },
        }),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Meta API send timed out after ${this.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Unknown error";

      log.warn({
        event: "meta_send_failed",
        error: message,
      });

      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");

      log.warn({
        event: "meta_send_failed",
        statusCode: response.status,
        responseBody,
      });

      throw new Error(`Meta API send failed with status ${response.status}`);
    }

    const responseBody = await response.json().catch(() => undefined);

    return {
      metaMessageId: extractMetaMessageId(responseBody),
    };
  }
}

const extractMetaMessageId = (responseBody: unknown) => {
  if (!responseBody || typeof responseBody !== "object") {
    return null;
  }

  const messages = (responseBody as { messages?: unknown }).messages;

  if (!Array.isArray(messages)) {
    return null;
  }

  const firstMessage = messages[0];

  if (!firstMessage || typeof firstMessage !== "object") {
    return null;
  }

  const id = (firstMessage as { id?: unknown }).id;

  return typeof id === "string" && id.trim() ? id : null;
};
