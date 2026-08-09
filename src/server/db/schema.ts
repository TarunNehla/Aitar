import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts, authSchema, authSessions, users, verifications } from "./auth-schema.js";

export { accounts, authSessions, users, verifications };

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull().default("selected"),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("github_installations_installation_idx").on(table.installationId),
    index("github_installations_account_idx").on(table.accountId),
  ],
);

export const githubInstallationUsers = pgTable(
  "github_installation_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_installation_users_unique_idx").on(table.installationId, table.userId),
    index("github_installation_users_user_idx").on(table.userId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    githubInstallationId: uuid("github_installation_id").references(() => githubInstallations.id, {
      onDelete: "set null",
    }),
    githubFullName: text("github_full_name"),
    githubOwnerLogin: text("github_owner_login"),
    githubPrivate: boolean("github_private").notNull().default(false),
    githubCloneUrl: text("github_clone_url"),
    githubAccess: text("github_access").notNull().default("granted"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("repositories_owner_idx").on(table.ownerUserId),
    index("repositories_installation_idx").on(table.githubInstallationId),
    uniqueIndex("repositories_owner_github_repository_idx")
      .on(table.ownerUserId, table.githubRepositoryId)
      .where(sql`${table.githubRepositoryId} IS NOT NULL`),
  ],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New session"),
    baseBranch: text("base_branch").notNull().default("main"),
    branchName: text("branch_name").notNull(),
    baseCommit: text("base_commit"),
    headCommit: text("head_commit"),
    envStatus: text("env_status").notNull().default("preparing"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
    provider: text("provider").notNull().default("openrouter"),
    defaultModel: text("default_model").notNull(),
    currentLeafMessageId: uuid("current_leaf_message_id"),
    status: text("status").notNull().default("active"),
    summary: text("summary"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    nextEventSequence: bigint("next_event_sequence", { mode: "number" }).notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("sessions_repository_idx").on(table.repositoryId),
    uniqueIndex("sessions_repository_branch_idx").on(table.repositoryId, table.branchName),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    parentMessageId: uuid("parent_message_id"),
    role: text("role").notNull(),
    model: text("model"),
    status: text("status").notNull().default("complete"),
    stopReason: text("stop_reason"),
    providerMessageId: text("provider_message_id"),
    ...timestamps,
  },
  (table) => [index("messages_session_idx").on(table.sessionId), index("messages_parent_idx").on(table.parentMessageId)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    model: text("model").notNull(),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    maxCostUsd: doublePrecision("max_cost_usd").notNull(),
    maxTurns: integer("max_turns").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("runs_claim_idx").on(table.status, table.createdAt),
    uniqueIndex("runs_one_active_session_idx")
      .on(table.sessionId)
      .where(sql`${table.status} IN ('pending', 'running', 'cancelling')`),
  ],
);

export const messageBlocks = pgTable(
  "message_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    text: text("text"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    visibility: text("visibility").notNull().default("both"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("message_blocks_position_idx").on(table.messageId, table.position)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("events_session_sequence_idx").on(table.sessionId, table.sequence), index("events_run_idx").on(table.runId)],
);

export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("running"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("tools_run_call_idx").on(table.runId, table.callId)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    mimeType: text("mime_type"),
    storagePath: text("storage_path").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("artifacts_session_idx").on(table.sessionId)],
);

export const contextSnapshots = pgTable("context_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  throughMessageId: uuid("through_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  importantFacts: jsonb("important_facts").$type<Record<string, unknown>>().notNull().default({}),
  tokenCount: integer("token_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatCheckpoints = pgTable(
  "chat_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    baseCommit: text("base_commit").notNull(),
    checkpointCommit: text("checkpoint_commit").notNull(),
    internalRef: text("internal_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("checkpoints_session_idx").on(table.sessionId, table.createdAt)],
);

/** Only what the console needs to link back to GitHub. No tokens, titles of record, or diffs. */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    state: text("state").notNull().default("open"),
    draft: boolean("draft").notNull().default(false),
    title: text("title").notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    headCommit: text("head_commit").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("pull_requests_session_number_idx").on(table.sessionId, table.number)],
);

export const schema = {
  ...authSchema,
  githubInstallations,
  githubInstallationUsers,
  repositories,
  chatSessions,
  runs,
  messages,
  messageBlocks,
  events,
  toolExecutions,
  artifacts,
  contextSnapshots,
  chatCheckpoints,
  pullRequests,
};
