import { tenants } from "./schema.js";
import { closeDb, db } from "./index.js";
import { logger } from "../../shared/logger/index.js";

const demoTenant = {
  name: "Myde Demo",
  phoneNumberId: "123456789012345",
};

await db
  .insert(tenants)
  .values(demoTenant)
  .onConflictDoUpdate({
    target: tenants.phoneNumberId,
    set: {
      name: demoTenant.name,
      updatedAt: new Date(),
    },
  });

logger.info({
  event: "database_seed_completed",
  phoneNumberId: demoTenant.phoneNumberId,
});

await closeDb();
