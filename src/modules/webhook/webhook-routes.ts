import type { FastifyInstance } from "fastify";
import { db } from "../../infra/db/index.js";
import { BullMqMessageQueue } from "../../infra/queue/message-queue.js";
import { MessageProcessingStatusService } from "../messages/message-processing-status-service.js";
import { ReceiveInboundMessageUseCase } from "../messages/receive-inbound-message-use-case.js";
import { env } from "../../shared/env/index.js";
import { createLogger } from "../../shared/logger/index.js";
import { createCorrelationId } from "../../shared/tracing/correlation-id.js";
import { parseMetaWebhookPayload } from "./meta-payload-parser.js";
import { SignatureService } from "./signature-service.js";

type WebhookVerificationQuery = {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
};

const signatureService = new SignatureService(env.META_APP_SECRET);
const receiveInboundMessageUseCase = new ReceiveInboundMessageUseCase(db);
const processingStatusService = new MessageProcessingStatusService(db);
const messageQueue = new BullMqMessageQueue();

export const registerWebhookRoutes = async (app: FastifyInstance) => {
  app.addHook("onClose", async () => {
    await messageQueue.close();
  });

  app.get<{ Querystring: WebhookVerificationQuery }>(
    "/webhook",
    async (request, reply) => {
      const mode = request.query["hub.mode"];
      const verifyToken = request.query["hub.verify_token"];
      const challenge = request.query["hub.challenge"];

      if (
        mode === "subscribe" &&
        verifyToken === env.META_VERIFY_TOKEN &&
        challenge
      ) {
        return reply.type("text/plain").send(challenge);
      }

      return reply.status(403).send({ error: "Invalid verify token" });
    },
  );

  app.post("/webhook", async (request, reply) => {
    const correlationId = createCorrelationId();
    const requestLogger = createLogger({ correlationId });
    const rawBody = request.body;
    const signatureHeader = request.headers["x-hub-signature-256"];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;

    requestLogger.info({ event: "webhook_received" });

    if (!Buffer.isBuffer(rawBody)) {
      requestLogger.error({ event: "webhook_raw_body_invalid" });
      return reply.status(500).send({ error: "Invalid raw body" });
    }

    if (!signatureService.isValidSignature(rawBody, signature)) {
      requestLogger.warn({ event: "signature_invalid" });
      return reply.status(401).send({ error: "Invalid signature" });
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      requestLogger.warn({ event: "webhook_payload_invalid_json" });
      return reply.send({ received: true, processed: 0 });
    }

    const parsedPayload = parseMetaWebhookPayload(payload);

    if (parsedPayload.kind === "ignored") {
      requestLogger.info({
        event: "webhook_payload_ignored",
        reason: parsedPayload.reason,
      });

      return reply.send({ received: true, processed: 0 });
    }

    let processed = 0;

    for (const inboundMessage of parsedPayload.messages) {
      try {
        const result = await receiveInboundMessageUseCase.execute({
          phoneNumberId: inboundMessage.phoneNumberId,
          metaMessageId: inboundMessage.messageId,
          from: inboundMessage.from,
          contactName: inboundMessage.contactName,
          text: inboundMessage.text,
          receivedAt: inboundMessage.timestamp,
          rawPayload: payload,
        });

        if (result.status === "unknown_tenant") {
          requestLogger.warn({
            event: "tenant_unknown",
            phoneNumberId: result.phoneNumberId,
            metaMessageId: result.metaMessageId,
          });
          continue;
        }

        const messageLogger = requestLogger.child({
          tenantId: result.tenantId,
          conversationId: result.conversationId,
          messageId: result.messageId,
          metaMessageId: result.metaMessageId,
        });

        if (result.status === "duplicated") {
          messageLogger.info({
            event: "message_already_processed",
            processingStatus: result.processingStatus,
            shouldRetryProcessing: result.shouldRetryProcessing,
          });

          if (!result.shouldRetryProcessing) {
            continue;
          }
        }

        processed += 1;

        if (result.status === "created") {
          messageLogger.info({ event: "message_persisted" });
        }

        let jobId: string;

        try {
          const enqueuedJob = await messageQueue.enqueueProcessInboundMessage({
            tenantId: result.tenantId,
            conversationId: result.conversationId,
            messageId: result.messageId,
            correlationId,
          });

          jobId = enqueuedJob.jobId;
        } catch (error) {
          messageLogger.error({
            event: "job_enqueue_failed",
            error: error instanceof Error ? error.message : "Unknown error",
          });
          continue;
        }

        try {
          await processingStatusService.markQueued({
            tenantId: result.tenantId,
            messageId: result.messageId,
          });

          messageLogger.info({ event: "job_enqueued", jobId });
        } catch (error) {
          messageLogger.error({
            event: "message_mark_queued_failed",
            jobId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } catch (error) {
        requestLogger.warn({
          event: "webhook_message_processing_failed",
          metaMessageId: inboundMessage.messageId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        continue;
      }
    }

    return reply.send({ received: true, processed });
  });
};
