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
  const connectionString = process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL is required to run database tests. Example: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/myde_test npm test",
    );
  }

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
