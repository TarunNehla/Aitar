import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "./client.js";

await migrate(db, { migrationsFolder: "drizzle" });
await closeDatabase();
