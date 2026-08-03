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

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repositoryUrl: text("repository_url").notNull(),
  ...timestamps,
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseBranch: text("base_branch").notNull().default("main"),
    baseCommit: text("base_commit"),
    localPath: text("local_path").notNull(),
    status: text("status").notNull().default("preparing"),
    sandboxId: text("sandbox_id"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [index("workspaces_project_idx").on(table.projectId)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New session"),
    provider: text("provider").notNull().default("openrouter"),
    defaultModel: text("default_model").notNull(),
    currentLeafMessageId: uuid("current_leaf_message_id"),
    status: text("status").notNull().default("active"),
    summary: text("summary"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    nextEventSequence: bigint("next_event_sequence", { mode: "number" }).notNull().default(1),
    ...timestamps,
  },
  (table) => [index("sessions_workspace_idx").on(table.workspaceId)],
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
  (table) => [
    index("messages_session_idx").on(table.sessionId),
    index("messages_parent_idx").on(table.parentMessageId),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
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
    uniqueIndex("runs_one_active_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.status} IN ('pending', 'running', 'waiting_for_approval', 'cancelling')`),
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
  (table) => [
    uniqueIndex("message_blocks_position_idx").on(table.messageId, table.position),
  ],
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
  (table) => [
    uniqueIndex("events_session_sequence_idx").on(table.sessionId, table.sequence),
    index("events_run_idx").on(table.runId),
  ],
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
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => chatSessions.id, { onDelete: "set null" }),
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
  (table) => [index("artifacts_workspace_idx").on(table.workspaceId)],
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

export const workspaceCheckpoints = pgTable(
  "workspace_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    baseCommit: text("base_commit").notNull(),
    checkpointCommit: text("checkpoint_commit").notNull(),
    internalRef: text("internal_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("checkpoints_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    toolExecutionId: uuid("tool_execution_id").references(() => toolExecutions.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    command: text("command"),
    status: text("status").notNull().default("pending"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("approvals_pending_idx").on(table.status, table.createdAt)],
);

export const schema = {
  projects,
  workspaces,
  chatSessions,
  runs,
  messages,
  messageBlocks,
  events,
  toolExecutions,
  artifacts,
  contextSnapshots,
  workspaceCheckpoints,
  approvalRequests,
};
