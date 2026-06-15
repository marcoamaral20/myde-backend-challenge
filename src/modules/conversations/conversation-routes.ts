import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../infra/db/index.js";
import { createLogger } from "../../shared/logger/index.js";
import { createRestTenantMiddleware } from "../tenants/rest-tenant-middleware.js";
import { ConversationRepository } from "./conversation-repository.js";
import { ConversationService } from "./conversation-service.js";

const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ConversationParamsSchema = z.object({
  id: z.string().uuid(),
});

const conversationRepository = new ConversationRepository(db);
const conversationService = new ConversationService(conversationRepository);
const restTenantMiddleware = createRestTenantMiddleware(db);

export const registerConversationRoutes = async (app: FastifyInstance) => {
  app.get(
    "/conversations",
    { preHandler: restTenantMiddleware },
    async (request, reply) => {
      const parsedQuery = PaginationQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        createLogger({
          event: "rest_conversations_query_invalid",
          tenantId: request.tenant.id,
        }).warn({ issues: parsedQuery.error.issues });

        return reply.status(400).send({
          error: "Invalid query parameters",
          issues: parsedQuery.error.issues,
        });
      }

      const conversations = await conversationService.listConversations({
        tenantId: request.tenant.id,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      createLogger({
        event: "rest_conversations_listed",
        tenantId: request.tenant.id,
      }).info({
        count: conversations.length,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      return reply.send({
        data: conversations,
        pagination: {
          limit: parsedQuery.data.limit,
          offset: parsedQuery.data.offset,
        },
      });
    },
  );

  app.get(
    "/conversations/:id/messages",
    { preHandler: restTenantMiddleware },
    async (request, reply) => {
      const parsedParams = ConversationParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        createLogger({
          event: "rest_conversation_messages_params_invalid",
          tenantId: request.tenant.id,
        }).warn({ issues: parsedParams.error.issues });

        return reply.status(400).send({
          error: "Invalid conversation id",
        });
      }

      const parsedQuery = PaginationQuerySchema.safeParse(request.query);

      if (!parsedQuery.success) {
        createLogger({
          event: "rest_conversation_messages_query_invalid",
          tenantId: request.tenant.id,
          conversationId: parsedParams.data.id,
        }).warn({ issues: parsedQuery.error.issues });

        return reply.status(400).send({
          error: "Invalid query parameters",
          issues: parsedQuery.error.issues,
        });
      }

      const messages = await conversationService.listConversationMessages({
        tenantId: request.tenant.id,
        conversationId: parsedParams.data.id,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      if (!messages) {
        createLogger({
          event: "rest_conversation_not_found",
          tenantId: request.tenant.id,
          conversationId: parsedParams.data.id,
        }).info({});

        return reply.status(404).send({
          error: "Conversation not found",
        });
      }

      createLogger({
        event: "rest_conversation_messages_listed",
        tenantId: request.tenant.id,
        conversationId: parsedParams.data.id,
      }).info({
        count: messages.length,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      return reply.send({
        data: messages,
        pagination: {
          limit: parsedQuery.data.limit,
          offset: parsedQuery.data.offset,
        },
      });
    },
  );
};
