import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDatabase, sql } from "../src/server/db/client.js";

const schemaName = `migration_test_${Date.now()}`;
const rollbackMarker = "migration-validation-complete";

const requiredTables = [
  "users",
  "accounts",
  "auth_sessions",
  "verifications",
  "github_installations",
  "github_installation_users",
  "repositories",
  "chat_sessions",
  "messages",
  "runs",
  "events",
  "chat_checkpoints",
  "approval_requests",
  "artifacts",
];

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir("drizzle");
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

async function statements(path: string): Promise<string[]> {
  const source = await readFile(path, "utf8");
  return source
    .replaceAll('"public".', `"${schemaName}".`)
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function write(line: string) {
  process.stdout.write(`${line}\n`);
}

try {
  const files = await migrationFiles();

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await transaction.unsafe(`SET LOCAL search_path TO "${schemaName}"`);

    for (const file of files) {
      const source = await readFile(join("drizzle", file), "utf8");
      if (/^\s*(DROP|TRUNCATE|DELETE)\b/im.test(source)) {
        throw new Error(`${file} contains a destructive statement`);
      }
      for (const statement of await statements(join("drizzle", file))) {
        await transaction.unsafe(statement);
      }
    }

    const tables = await transaction.unsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaName}'`,
    );
    const tableNames = tables.map((row) => row.table_name);
    for (const required of requiredTables) {
      if (!tableNames.includes(required)) throw new Error(`${required} table was not created`);
    }
    if (tableNames.includes("sessions")) throw new Error("Better Auth sessions table shadowed chat_sessions");

    const [ownerColumn] = await transaction.unsafe<Array<{ is_nullable: string }>>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = '${schemaName}' AND table_name = 'repositories' AND column_name = 'owner_user_id'
    `);
    if (!ownerColumn) throw new Error("repositories.owner_user_id is missing");
    if (ownerColumn.is_nullable !== "NO") throw new Error("repositories.owner_user_id must be required");

    const tokenColumns = await transaction.unsafe<Array<{ table_name: string; column_name: string }>>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = '${schemaName}'
        AND table_name IN ('github_installations', 'github_installation_users', 'repositories')
        AND (column_name ILIKE '%token%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%private_key%')
    `);
    if (tokenColumns.length > 0) throw new Error("GitHub tables must not store token material");

    await transaction.unsafe(`
      INSERT INTO users (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.com');
      INSERT INTO repositories (id, owner_user_id, name, repository_url)
      VALUES (
        '00000000-0000-0000-0000-000000000001', 'user-1', 'Example',
        'https://github.com/example/repository'
      );
      INSERT INTO chat_sessions (id, repository_id, branch_name, default_model)
      VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'agent/00000000-0000-0000-0000-000000000002',
        'example/model'
      );
    `);

    const [orphan] = await transaction.unsafe<Array<{ blocked: boolean }>>(`
      SELECT NOT EXISTS (
        SELECT 1 FROM repositories WHERE owner_user_id IS NULL
      ) AS blocked
    `);
    if (!orphan?.blocked) throw new Error("repositories may exist without an owner");

    await transaction.unsafe(`DELETE FROM users WHERE id = 'user-1'`);
    const [remaining] = await transaction.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM chat_sessions`,
    );
    if (remaining?.count !== "0") throw new Error("deleting a user must cascade to their chats");

    throw new Error(rollbackMarker);
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== rollbackMarker) throw error;
  write("Migration validation passed.");
} finally {
  await closeDatabase();
}
