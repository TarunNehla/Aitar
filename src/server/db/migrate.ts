import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "./client.js";
import { errorForLog, logger } from "../logger.js";

logger.info("Database migration started");
try {
  await migrate(db, { migrationsFolder: "drizzle" });
  logger.info("Database migration completed");
} catch (error) {
  logger.error({ error: errorForLog(error) }, "Database migration failed");
  throw error;
} finally {
  await closeDatabase();
}
