ALTER TABLE "projects" RENAME TO "repositories";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "default_branch" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_fetched_at" timestamp with time zone;--> statement-breakpoint
UPDATE "repositories" AS repository
SET "default_branch" = COALESCE(
  (
    SELECT workspace."base_branch"
    FROM "workspaces" AS workspace
    WHERE workspace."project_id" = repository."id"
    ORDER BY workspace."updated_at" DESC
    LIMIT 1
  ),
  'main'
);--> statement-breakpoint

ALTER TABLE "chat_sessions" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "base_branch" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "branch_name" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "base_commit" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "head_commit" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "env_status" text DEFAULT 'preparing' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "chat_sessions" AS session
SET
  "repository_id" = workspace."project_id",
  "base_branch" = workspace."base_branch",
  "branch_name" = 'agent/' || session."id"::text,
  "base_commit" = workspace."base_commit",
  "head_commit" = COALESCE(
    (
      SELECT checkpoint."checkpoint_commit"
      FROM "workspace_checkpoints" AS checkpoint
      JOIN "runs" AS checkpoint_run ON checkpoint_run."id" = checkpoint."run_id"
      WHERE checkpoint_run."session_id" = session."id"
      ORDER BY checkpoint."created_at" DESC
      LIMIT 1
    ),
    workspace."base_commit"
  ),
  "env_status" = CASE WHEN workspace."status" = 'ready' THEN 'migration_required' ELSE workspace."status" END,
  "last_active_at" = workspace."last_active_at",
  "settings" = session."settings" || jsonb_build_object('legacy_workspace_id', workspace."id"::text)
FROM "workspaces" AS workspace
WHERE session."workspace_id" = workspace."id";--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "repository_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "branch_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_repository_idx" ON "chat_sessions" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_repository_branch_idx" ON "chat_sessions" USING btree ("repository_id", "branch_name");--> statement-breakpoint

ALTER TABLE "workspace_checkpoints" ADD COLUMN "session_id" uuid;--> statement-breakpoint
UPDATE "workspace_checkpoints" AS checkpoint
SET "session_id" = COALESCE(
  checkpoint_run."session_id",
  (
    SELECT session."id"
    FROM "chat_sessions" AS session
    WHERE session."workspace_id" = checkpoint."workspace_id"
    ORDER BY session."created_at"
    LIMIT 1
  )
)
FROM "runs" AS checkpoint_run
WHERE checkpoint_run."id" = checkpoint."run_id";--> statement-breakpoint
UPDATE "workspace_checkpoints" AS checkpoint
SET "session_id" = (
  SELECT session."id"
  FROM "chat_sessions" AS session
  WHERE session."workspace_id" = checkpoint."workspace_id"
  ORDER BY session."created_at"
  LIMIT 1
)
WHERE checkpoint."session_id" IS NULL;--> statement-breakpoint
DELETE FROM "workspace_checkpoints" WHERE "session_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

UPDATE "artifacts" AS artifact
SET "session_id" = COALESCE(
  artifact."session_id",
  (
    SELECT artifact_run."session_id"
    FROM "runs" AS artifact_run
    WHERE artifact_run."id" = artifact."run_id"
  ),
  (
    SELECT session."id"
    FROM "chat_sessions" AS session
    WHERE session."workspace_id" = artifact."workspace_id"
    ORDER BY session."created_at"
    LIMIT 1
  )
);--> statement-breakpoint
DELETE FROM "artifacts" WHERE "session_id" IS NULL;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_session_id_chat_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

DROP INDEX "runs_one_active_workspace_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_session_idx" ON "runs" USING btree ("session_id") WHERE "runs"."status" IN ('pending', 'running', 'waiting_for_approval', 'cancelling');--> statement-breakpoint

DELETE FROM "events" WHERE "type" IN ('stdout_chunk', 'stderr_chunk', 'file_changed');--> statement-breakpoint
UPDATE "events"
SET "payload" = "payload" - 'arguments' - 'result' - 'command'
WHERE "type" IN ('tool_started', 'tool_completed', 'approval_requested');--> statement-breakpoint
DELETE FROM "message_blocks" WHERE "type" = 'reasoning_summary';--> statement-breakpoint
UPDATE "message_blocks"
SET "data" = jsonb_set(
  "data",
  '{arguments}',
  CASE "data"->>'name'
    WHEN 'write_file' THEN jsonb_build_object('path', "data"#>>'{arguments,path}')
    WHEN 'run_command' THEN jsonb_build_object('network', COALESCE("data"#>>'{arguments,network}', 'false')::boolean)
    ELSE '{}'::jsonb
  END,
  true
)
WHERE "type" = 'tool_call';--> statement-breakpoint
UPDATE "message_blocks"
SET "text" = CASE "data"->>'toolName'
  WHEN 'read_file' THEN 'File read completed. File contents were not stored.'
  WHEN 'search_files' THEN 'File search completed. Search results were not stored.'
  WHEN 'list_files' THEN 'File listing completed. The listing was not stored.'
  WHEN 'git_diff' THEN 'Git diff completed. The patch is generated from Git when requested.'
  WHEN 'run_command' THEN 'Command completed. Full output was not stored.'
  ELSE "text"
END
WHERE "type" = 'tool_result';--> statement-breakpoint
UPDATE "tool_executions"
SET
  "arguments" = CASE "tool_name"
    WHEN 'write_file' THEN jsonb_build_object('path', "arguments"->>'path')
    WHEN 'run_command' THEN jsonb_build_object('network', COALESCE("arguments"->>'network', 'false')::boolean)
    ELSE '{}'::jsonb
  END,
  "result" = CASE
    WHEN "result" IS NULL THEN NULL
    ELSE jsonb_build_object('summary', replace("tool_name", '_', ' ') || ' completed. Full output was not stored.')
  END;--> statement-breakpoint
UPDATE "approval_requests" SET "command" = NULL WHERE "status" <> 'pending';--> statement-breakpoint

ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" DROP CONSTRAINT "workspace_checkpoints_workspace_id_workspaces_id_fk";--> statement-breakpoint
DROP INDEX "artifacts_workspace_idx";--> statement-breakpoint
DROP INDEX "sessions_workspace_idx";--> statement-breakpoint
DROP INDEX "checkpoints_workspace_idx";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" RENAME TO "chat_checkpoints";--> statement-breakpoint
ALTER TABLE "chat_checkpoints" RENAME CONSTRAINT "workspace_checkpoints_session_id_chat_sessions_id_fk" TO "chat_checkpoints_session_id_chat_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "chat_checkpoints" RENAME CONSTRAINT "workspace_checkpoints_run_id_runs_id_fk" TO "chat_checkpoints_run_id_runs_id_fk";--> statement-breakpoint
CREATE INDEX "artifacts_session_idx" ON "artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "checkpoints_session_idx" ON "chat_checkpoints" USING btree ("session_id", "created_at");--> statement-breakpoint
DROP TABLE "workspaces";
