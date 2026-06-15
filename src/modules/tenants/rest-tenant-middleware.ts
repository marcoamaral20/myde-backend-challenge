import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { tenants } from "../../infra/db/schema.js";
import type * as schema from "../../infra/db/schema.js";
import { createLogger } from "../../shared/logger/index.js";

export type RestTenantContext = {
  id: string;
  name: string;
  phoneNumberId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    tenant: RestTenantContext;
  }
}

const TenantIdHeaderSchema = z.string().uuid();

export const createRestTenantMiddleware =
  (database: NodePgDatabase<typeof schema>) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantIdHeader = request.headers["x-tenant-id"];
    const tenantId = Array.isArray(tenantIdHeader)
      ? tenantIdHeader[0]
      : tenantIdHeader;

    if (!tenantId) {
      createLogger({ event: "rest_tenant_header_missing" }).warn({
        path: request.url,
      });

      return reply.status(401).send({
        error: "Missing x-tenant-id header",
      });
    }

    const parsedTenantId = TenantIdHeaderSchema.safeParse(tenantId);

    if (!parsedTenantId.success) {
      createLogger({ event: "rest_tenant_header_invalid" }).warn({
        path: request.url,
      });

      return reply.status(400).send({
        error: "Invalid x-tenant-id header",
      });
    }

    const [tenant] = await database
      .select({
        id: tenants.id,
        name: tenants.name,
        phoneNumberId: tenants.phoneNumberId,
      })
      .from(tenants)
      .where(eq(tenants.id, parsedTenantId.data))
      .limit(1);

    if (!tenant) {
      createLogger({
        event: "rest_tenant_not_found",
        tenantId: parsedTenantId.data,
      }).warn({
        path: request.url,
      });

      return reply.status(401).send({
        error: "Invalid tenant",
      });
    }

    // Challenge-only simulated authentication: production should replace this
    // header lookup with tenant-aware auth such as JWT, API keys or OAuth.
    request.tenant = tenant;

    createLogger({
      event: "rest_tenant_resolved",
      tenantId: tenant.id,
    }).info({
      path: request.url,
    });
  };
