CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"message_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"mime_type" text,
	"storage_path" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "chat_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"base_commit" text NOT NULL,
	"checkpoint_commit" text NOT NULL,
	"internal_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"title" text DEFAULT 'New session' NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"published_branch" text,
	"base_commit" text,
	"head_commit" text,
	"env_status" text DEFAULT 'idle' NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text DEFAULT 'openrouter' NOT NULL,
	"default_model" text NOT NULL,
	"current_leaf_message_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"summary" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_event_sequence" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"through_message_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"important_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text DEFAULT 'selected' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'both' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"parent_message_id" uuid,
	"role" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'complete' NOT NULL,
	"stop_reason" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_commit" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"repository_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"github_repository_id" bigint,
	"github_installation_id" uuid,
	"github_full_name" text,
	"github_owner_login" text,
	"github_private" boolean DEFAULT false NOT NULL,
	"github_clone_url" text,
	"github_access" text DEFAULT 'granted' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"max_cost_usd" double precision NOT NULL,
	"max_turns" integer NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"exit_code" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_checkpoints" ADD CONSTRAINT "chat_checkpoints_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_checkpoints" ADD CONSTRAINT "chat_checkpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_through_message_id_messages_id_fk" FOREIGN KEY ("through_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_users" ADD CONSTRAINT "github_installation_users_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_users" ADD CONSTRAINT "github_installation_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_blocks" ADD CONSTRAINT "message_blocks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artifacts_session_idx" ON "artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "checkpoints_session_idx" ON "chat_checkpoints" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_repository_idx" ON "chat_sessions" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_published_branch_idx" ON "chat_sessions" USING btree ("repository_id","published_branch") WHERE "chat_sessions"."published_branch" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_session_sequence_idx" ON "events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_users_unique_idx" ON "github_installation_users" USING btree ("installation_id","user_id");--> statement-breakpoint
CREATE INDEX "github_installation_users_user_idx" ON "github_installation_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_idx" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_installations_account_idx" ON "github_installations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_blocks_position_idx" ON "message_blocks" USING btree ("message_id","position");--> statement-breakpoint
CREATE INDEX "messages_session_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_parent_idx" ON "messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_session_number_idx" ON "pull_requests" USING btree ("session_id","number");--> statement-breakpoint
CREATE INDEX "repositories_owner_idx" ON "repositories" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "repositories_installation_idx" ON "repositories" USING btree ("github_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_owner_github_repository_idx" ON "repositories" USING btree ("owner_user_id","github_repository_id") WHERE "repositories"."github_repository_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_claim_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_session_idx" ON "runs" USING btree ("session_id") WHERE "runs"."status" IN ('pending', 'running', 'cancelling');--> statement-breakpoint
CREATE UNIQUE INDEX "tools_run_call_idx" ON "tool_executions" USING btree ("run_id","call_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");