import { readFile } from "node:fs/promises";
import { closeDatabase, sql } from "../src/server/db/client.js";

const schemaName = `migration_test_${Date.now()}`;
const rollbackMarker = "migration-validation-complete";

async function statements(path: string): Promise<string[]> {
  const source = await readFile(path, "utf8");
  return source
    .replaceAll('"public".', `"${schemaName}".`)
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

try {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await transaction.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
    for (const path of ["drizzle/0000_parallel_stature.sql", "drizzle/0001_whole_mephistopheles.sql"]) {
      for (const statement of await statements(path)) await transaction.unsafe(statement);
    }

    await transaction.unsafe(`
      INSERT INTO projects (id, name, repository_url)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Example', 'https://github.com/example/repository');
      INSERT INTO workspaces (id, project_id, name, base_branch, base_commit, local_path, status)
      VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001',
        'Main', 'main', repeat('a', 40), '/legacy/repository', 'ready'
      );
      INSERT INTO chat_sessions (id, workspace_id, title, default_model)
      VALUES (
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        'Chat', 'example/model'
      );
      INSERT INTO messages (id, session_id, role)
      VALUES (
        '00000000-0000-0000-0000-000000000004',
        '00000000-0000-0000-0000-000000000003',
        'user'
      );
      INSERT INTO runs (id, session_id, workspace_id, user_message_id, model, max_cost_usd, max_turns)
      VALUES (
        '00000000-0000-0000-0000-000000000005',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000004',
        'example/model', 1, 10
      );
      INSERT INTO workspace_checkpoints (workspace_id, run_id, base_commit, checkpoint_commit, internal_ref)
      VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000005',
        repeat('a', 40), repeat('b', 40), 'refs/heads/legacy'
      );
      INSERT INTO artifacts (workspace_id, session_id, name, type, storage_path)
      VALUES (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003',
        'result', 'file', '/legacy/result'
      );
    `);

    for (const statement of await statements("drizzle/0002_huge_human_torch.sql")) {
      await transaction.unsafe(statement);
    }

    const [session] = await transaction.unsafe<Array<{
      repository_id: string;
      branch_name: string;
      head_commit: string;
    }>>(`SELECT repository_id, branch_name, head_commit FROM chat_sessions`);
    const [checkpoint] = await transaction.unsafe<Array<{ session_id: string }>>(
      `SELECT session_id FROM chat_checkpoints`,
    );
    const [workspace] = await transaction.unsafe<Array<{ exists: boolean }>>(
      `SELECT to_regclass('${schemaName}.workspaces') IS NOT NULL AS exists`,
    );

    if (session?.repository_id !== "00000000-0000-0000-0000-000000000001") throw new Error("repository relation was not preserved");
    if (session.branch_name !== "agent/00000000-0000-0000-0000-000000000003") throw new Error("chat branch was not created");
    if (session.head_commit !== "b".repeat(40)) throw new Error("latest checkpoint was not preserved");
    if (checkpoint?.session_id !== "00000000-0000-0000-0000-000000000003") throw new Error("checkpoint relation was not preserved");
    if (workspace?.exists) throw new Error("workspace table still exists");

    throw new Error(rollbackMarker);
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== rollbackMarker) throw error;
  process.stdout.write("Migration validation passed.\n");
} finally {
  await closeDatabase();
}
