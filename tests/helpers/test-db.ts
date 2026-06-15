import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../src/infra/db/schema.js";

const { Pool } = pg;

export type TestDatabase = {
  db: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
};

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const connectionString =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/myde";

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
};
