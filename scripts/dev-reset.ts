import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { config } from "../src/server/config.js";
import { closeDatabase, sql } from "../src/server/db/client.js";
import { schema } from "../src/server/db/schema.js";
import { runProcess } from "../src/server/runtime/process.js";
import { verifyResetTarget } from "../src/server/runtime/reset-safety.js";

/** Tables this application has owned at some point. Nothing else is ever touched. */
const legacyTables = ["approval_requests", "workspaces", "sessions"];

const runtimeDirectories = [
  { name: "chats", description: "chat checkouts" },
  { name: "repos", description: "repository mirrors and checkpoint refs" },
  { name: "workspaces", description: "old workspace directories" },
  { name: "credentials", description: "askpass helper regenerated on boot" },
];

const containerPrefix = "cloud-agent-";
const dryRun = process.argv.includes("--dry-run");

function write(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(reason: string): never {
  process.stderr.write(`Development reset refused: ${reason}\n`);
  process.exit(1);
}

function sourceRepositoryRoot(): string {
  return resolve(new URL("..", import.meta.url).pathname);
}

function verifiedWorkspaceRoot(): string {
  const target = verifyResetTarget({
    configuredValue: process.env.WORKSPACE_ROOT ?? ".cloud-agent",
    resolvedRoot: config.WORKSPACE_ROOT,
    sourceRepositoryRoot: sourceRepositoryRoot(),
  });
  if (!target.ok) fail(target.reason);
  return target.root;
}

function databaseScope() {
  const url = new URL(config.DATABASE_URL);
  return {
    host: url.hostname,
    database: url.pathname.replace(/^\//, "") || "postgres",
    schema: "public",
    tables: [...new Set([...Object.values(schema).map((table) => getTableName(table)), ...legacyTables])].sort(),
  };
}

async function existingDirectories(root: string) {
  const present: Array<{ path: string; description: string }> = [];
  for (const directory of runtimeDirectories) {
    const path = join(root, directory.name);
    try {
      await stat(path);
      present.push({ path, description: directory.description });
    } catch {
      // A directory that was never created needs no cleanup.
    }
  }
  return present;
}

async function applicationContainers(): Promise<string[]> {
  const result = await runProcess(
    "docker",
    ["ps", "-a", "--filter", `name=^/${containerPrefix}`, "--format", "{{.Names}}"],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.startsWith(containerPrefix));
}

if (config.NODE_ENV === "production") fail("this command never runs against a production environment");

const root = verifiedWorkspaceRoot();
const scope = databaseScope();
const directories = await existingDirectories(root);
const containers = await applicationContainers();

write(`Cloud Agents development reset${dryRun ? " (dry run)" : ""}`);
write();
write("Database scope");
write(`  host      ${scope.host}`);
write(`  database  ${scope.database}`);
write(`  schema    ${scope.schema}`);
write(`  action    DROP TABLE ... CASCADE, then re-apply drizzle/ from the current schema definitions`);
write(`  tables    ${scope.tables.length}`);
for (const table of scope.tables) write(`            ${scope.schema}.${table}`);
write("  Nothing outside these tables is touched. Other databases, schemas, and roles are untouched.");
write();
write(`Directories under ${root}`);
if (directories.length === 0) write("  (nothing to remove)");
for (const directory of directories) write(`  ${directory.path}  — ${directory.description}`);
write(`  The Cloud Agents source repository at ${sourceRepositoryRoot()} is never a deletion target.`);
write();
write("Containers");
if (containers.length === 0) write(`  (no ${containerPrefix}* containers)`);
for (const container of containers) write(`  ${container}`);
write(`  Only containers named ${containerPrefix}* are removed. Process logs live inside them and go with them.`);
write();

if (dryRun) {
  write("Dry run: nothing was changed.");
  await closeDatabase();
  process.exit(0);
}

try {
  const quoted = scope.tables.map((table) => `"${scope.schema}"."${table}"`).join(", ");
  await sql.unsafe(`DROP TABLE IF EXISTS ${quoted} CASCADE`);
  await sql.unsafe(`DROP TABLE IF EXISTS "drizzle"."__drizzle_migrations"`);
  write(`Dropped ${scope.tables.length} application tables from ${scope.database}.`);

  for (const directory of directories) {
    await rm(directory.path, { recursive: true, force: true });
    write(`Removed ${directory.path}`);
  }

  for (const container of containers) {
    await runProcess("docker", ["rm", "-f", container], { timeoutMs: 60_000 });
    write(`Removed container ${container}`);
  }
} finally {
  await closeDatabase();
}

const migrated = await runProcess(process.execPath, [
  join(sourceRepositoryRoot(), "node_modules", "tsx", "dist", "cli.mjs"),
  join(sourceRepositoryRoot(), "src", "server", "db", "migrate.ts"),
], { timeoutMs: 180_000, cwd: sourceRepositoryRoot() });

if (migrated.exitCode !== 0) {
  process.stderr.write(migrated.stderr || migrated.stdout);
  fail("the empty schema could not be recreated");
}

write();
write("Reset complete. The application schema was recreated empty from the current definitions.");
