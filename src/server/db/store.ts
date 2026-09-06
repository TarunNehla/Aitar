import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { MessageView, SessionEvent } from "../../shared/contracts.js";
import { asThinkingLevel, defaultThinkingLevelFor, type ThinkingLevel } from "../../shared/models.js";
import { config } from "../config.js";
import { eventHub } from "../events/event-hub.js";
import { db, sql } from "./client.js";
import {
  artifacts,
  chatCheckpoints,
  chatSessions,
  contextSnapshots,
  events,
  messageBlocks,
  messages,
  pullRequests,
  repositories,
  runs,
  toolExecutions,
} from "./schema.js";

const activeRunStatuses = ["pending", "running", "cancelling"] as const;

export type Access<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "forbidden" };

export type RepositoryRow = typeof repositories.$inferSelect;
export type SessionRelation = { session: typeof chatSessions.$inferSelect; repository: RepositoryRow };

function accessFor<T>(row: T | undefined, ownerUserId: string | undefined, userId: string): Access<T> {
  if (!row) return { status: "not_found" };
  if (ownerUserId !== userId) return { status: "forbidden" };
  return { status: "ok", value: row };
}

export async function createRepository(input: {
  id: string;
  ownerUserId: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  githubRepositoryId?: number;
  githubInstallationId?: string;
  githubFullName?: string;
  githubOwnerLogin?: string;
  githubPrivate?: boolean;
  githubCloneUrl?: string;
}) {
  const [repository] = await db.insert(repositories).values(input).returning();
  return repository;
}

export async function listRepositories(ownerUserId: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerUserId, ownerUserId))
    .orderBy(desc(repositories.updatedAt));
}

export async function getRepository(repositoryId: string) {
  const [repository] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1);
  return repository;
}

export async function getRepositoryForUser(repositoryId: string, userId: string): Promise<Access<RepositoryRow>> {
  const repository = await getRepository(repositoryId);
  return accessFor(repository, repository?.ownerUserId, userId);
}

export async function findRepositoryByGithubId(input: { ownerUserId: string; githubRepositoryId: number }) {
  const [repository] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerUserId, input.ownerUserId),
        eq(repositories.githubRepositoryId, input.githubRepositoryId),
      ),
    )
    .limit(1);
  return repository;
}

export async function updateRepositoryFetched(repositoryId: string) {
  const [repository] = await db
    .update(repositories)
    .set({ lastFetchedAt: new Date(), updatedAt: new Date() })
    .where(eq(repositories.id, repositoryId))
    .returning();
  return repository;
}

export async function createSession(input: {
  id: string;
  repositoryId: string;
  title: string;
  baseBranch: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}) {
  const model = input.model ?? config.OPENROUTER_MODEL;
  const [session] = await db
    .insert(chatSessions)
    .values({
      id: input.id,
      repositoryId: input.repositoryId,
      title: input.title,
      baseBranch: input.baseBranch,
      defaultModel: model,
      defaultThinkingLevel: input.thinkingLevel ?? defaultThinkingLevelFor(model),
    })
    .returning();
  return session;
}

export async function updateSessionModel(input: {
  sessionId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}) {
  const [session] = await db
    .update(chatSessions)
    .set({
      defaultModel: input.model,
      defaultThinkingLevel: input.thinkingLevel,
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, input.sessionId))
    .returning();
  return session;
}

export async function updateSessionBaseBranch(input: {
  sessionId: string;
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
}) {
  const [session] = await db
    .update(chatSessions)
    .set({
      baseBranch: input.baseBranch,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      envStatus: "ready",
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, input.sessionId))
    .returning();
  return session;
}

export async function saveSessionPublishedBranch(sessionId: string, publishedBranch: string) {
  const [session] = await db
    .update(chatSessions)
    .set({ publishedBranch, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId))
    .returning();
  return session;
}

export async function updateSessionEnvironment(input: {
  sessionId: string;
  envStatus: string;
  baseCommit?: string;
  headCommit?: string;
}) {
  const [session] = await db
    .update(chatSessions)
    .set({
      envStatus: input.envStatus,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.headCommit ? { headCommit: input.headCommit } : {}),
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatSessions.id, input.sessionId))
    .returning();
  return session;
}

export async function updateSessionTitle(sessionId: string, title: string) {
  const [session] = await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId))
    .returning();
  return session;
}

export async function updateSessionHead(sessionId: string, headCommit: string) {
  await db
    .update(chatSessions)
    .set({ headCommit, envStatus: "ready", lastActiveAt: new Date(), updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

export async function claimIdleSessionForEviction(idleBefore: Date) {
  const [session] = await sql<Array<{ id: string; repository_id: string; head_commit: string }>>`
    UPDATE chat_sessions
    SET env_status = 'evicting', updated_at = NOW()
    WHERE id = (
      SELECT candidate.id
      FROM chat_sessions AS candidate
      WHERE candidate.env_status = 'ready'
        AND candidate.head_commit IS NOT NULL
        AND candidate.last_active_at < ${idleBefore}
        AND NOT EXISTS (
          SELECT 1
          FROM runs
          WHERE runs.session_id = candidate.id
            AND runs.status IN ('pending', 'running', 'cancelling')
        )
      ORDER BY candidate.last_active_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, repository_id, head_commit
  `;
  return session;
}

export async function listSessions(ownerUserId: string, repositoryId?: string) {
  const ownedByUser = eq(repositories.ownerUserId, ownerUserId);
  return db
    .select({ session: chatSessions, repository: repositories })
    .from(chatSessions)
    .innerJoin(repositories, eq(chatSessions.repositoryId, repositories.id))
    .where(repositoryId ? and(ownedByUser, eq(chatSessions.repositoryId, repositoryId)) : ownedByUser)
    .orderBy(desc(chatSessions.updatedAt));
}

export async function getSession(sessionId: string) {
  const [result] = await db
    .select({ session: chatSessions, repository: repositories })
    .from(chatSessions)
    .innerJoin(repositories, eq(chatSessions.repositoryId, repositories.id))
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return result;
}

export async function getSessionForUser(sessionId: string, userId: string): Promise<Access<SessionRelation>> {
  const relation = await getSession(sessionId);
  return accessFor(relation, relation?.repository.ownerUserId, userId);
}

export async function getRunForUser(runId: string, userId: string): Promise<Access<typeof runs.$inferSelect>> {
  const [row] = await db
    .select({ run: runs, repository: repositories })
    .from(runs)
    .innerJoin(chatSessions, eq(runs.sessionId, chatSessions.id))
    .innerJoin(repositories, eq(chatSessions.repositoryId, repositories.id))
    .where(eq(runs.id, runId))
    .limit(1);
  return accessFor(row?.run, row?.repository.ownerUserId, userId);
}

export async function getArtifactForUser(
  artifactId: string,
  userId: string,
): Promise<Access<typeof artifacts.$inferSelect>> {
  const [row] = await db
    .select({ artifact: artifacts, repository: repositories })
    .from(artifacts)
    .innerJoin(chatSessions, eq(artifacts.sessionId, chatSessions.id))
    .innerJoin(repositories, eq(chatSessions.repositoryId, repositories.id))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  return accessFor(row?.artifact, row?.repository.ownerUserId, userId);
}

export async function getArtifactForChat(artifactId: string, sessionId: string) {
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.sessionId, sessionId)))
    .limit(1);
  return artifact;
}

export async function createUserMessageAndRun(input: {
  sessionId: string;
  text: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  parentMessageId?: string | null;
}) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, input.sessionId))
      .limit(1)
      .for("update");

    if (!session) {
      throw new Error("Session not found");
    }
    if (session.envStatus === "evicting") throw new Error("This chat environment is being cleaned up");

    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, session.id),
          inArray(runs.status, [...activeRunStatuses]),
        ),
      )
      .limit(1);

    if (active.length > 0) {
      throw new Error("This chat already has an active run");
    }

    const [message] = await tx
      .insert(messages)
      .values({
        sessionId: input.sessionId,
        parentMessageId: input.parentMessageId ?? session.currentLeafMessageId,
        role: "user",
      })
      .returning();

    await tx.insert(messageBlocks).values({
      messageId: message.id,
      position: 0,
      type: "text",
      text: input.text,
      visibility: "both",
    });

    const [run] = await tx
      .insert(runs)
      .values({
        sessionId: input.sessionId,
        userMessageId: message.id,
        model: input.model ?? session.defaultModel,
        thinkingLevel: input.thinkingLevel ?? asThinkingLevel(session.defaultThinkingLevel),
        maxCostUsd: config.RUN_MAX_COST_USD,
        maxTurns: config.RUN_MAX_TURNS,
      })
      .returning();

    await tx.update(messages).set({ runId: run.id }).where(eq(messages.id, message.id));
    await tx
      .update(chatSessions)
      .set({ currentLeafMessageId: message.id, lastActiveAt: new Date(), updatedAt: new Date() })
      .where(eq(chatSessions.id, input.sessionId));

    return { message, run };
  });
}

export async function getActiveRunForSession(sessionId: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.sessionId, sessionId),
        inArray(runs.status, [...activeRunStatuses]),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return run;
}

export async function createQueuedUserMessage(input: { sessionId: string; runId: string; text: string }) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({ sessionId: input.sessionId, runId: input.runId, role: "user", status: "queued" })
      .returning();
    await tx.insert(messageBlocks).values({
      messageId: message.id,
      position: 0,
      type: "text",
      text: input.text,
      visibility: "both",
    });
    return message;
  });
}

export async function activateQueuedMessage(input: { messageId: string; parentMessageId: string | null }) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .update(messages)
      .set({ parentMessageId: input.parentMessageId, status: "complete", updatedAt: new Date() })
      .where(eq(messages.id, input.messageId))
      .returning();
    if (!message) throw new Error("Queued message not found");
    await tx
      .update(chatSessions)
      .set({ currentLeafMessageId: message.id, updatedAt: new Date() })
      .where(eq(chatSessions.id, message.sessionId));
    return message;
  });
}

export async function deleteQueuedMessage(messageId: string) {
  await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.status, "queued")));
}

export async function createAgentMessage(input: {
  sessionId: string;
  runId: string;
  parentMessageId: string | null;
  role: "assistant" | "tool";
  model?: string;
  status?: string;
  stopReason?: string;
  blocks: Array<{
    type: string;
    text?: string;
    data?: Record<string, unknown>;
    visibility?: string;
  }>;
}) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({
        sessionId: input.sessionId,
        runId: input.runId,
        parentMessageId: input.parentMessageId,
        role: input.role,
        model: input.model,
        status: input.status ?? "complete",
        stopReason: input.stopReason,
      })
      .returning();

    if (input.blocks.length > 0) {
      await tx.insert(messageBlocks).values(
        input.blocks.map((block, position) => ({
          messageId: message.id,
          position,
          type: block.type,
          text: block.text,
          data: block.data ?? {},
          visibility: block.visibility ?? "both",
        })),
      );
    }

    await tx
      .update(chatSessions)
      .set({ currentLeafMessageId: message.id, updatedAt: new Date() })
      .where(eq(chatSessions.id, input.sessionId));

    return message;
  });
}

export async function getActiveBranchMessages(sessionId: string): Promise<MessageView[]> {
  const session = await getSession(sessionId);
  if (!session) return [];

  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  const byId = new Map(allMessages.map((message) => [message.id, message]));
  const branch = [];
  let currentId = session.session.currentLeafMessageId;

  while (currentId) {
    const message = byId.get(currentId);
    if (!message) break;
    branch.push(message);
    currentId = message.parentMessageId;
  }
  branch.reverse();

  const queued = allMessages.filter((message) => message.status === "queued");
  const visibleMessages = [...branch, ...queued];
  const ids = visibleMessages.map((message) => message.id);
  const blocks = ids.length
    ? await db
        .select()
        .from(messageBlocks)
        .where(inArray(messageBlocks.messageId, ids))
        .orderBy(asc(messageBlocks.position))
    : [];

  return visibleMessages.map((message) => ({
    id: message.id,
    parentMessageId: message.parentMessageId,
    role: message.role as MessageView["role"],
    status: message.status,
    model: message.model,
    createdAt: message.createdAt.toISOString(),
    blocks: blocks
      .filter((block) => block.messageId === message.id)
      .map((block) => ({
        id: block.id,
        position: block.position,
        type: block.type as MessageView["blocks"][number]["type"],
        text: block.text,
        data: block.data,
        visibility: block.visibility as MessageView["blocks"][number]["visibility"],
      })),
  }));
}

export async function appendEvent(input: {
  sessionId: string;
  runId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<SessionEvent> {
  const row = await sql.begin(async (tx) => {
    const [counter] = await tx<[{ sequence: number }]>`
      UPDATE chat_sessions
      SET next_event_sequence = next_event_sequence + 1,
          updated_at = NOW()
      WHERE id = ${input.sessionId}
      RETURNING next_event_sequence - 1 AS sequence
    `;

    if (!counter) throw new Error("Session not found");

    const [created] = await tx<
      [{ id: number; session_id: string; run_id: string | null; sequence: number; type: string; payload: Record<string, unknown>; created_at: Date | string }]
    >`
      INSERT INTO events (session_id, run_id, sequence, type, payload)
      VALUES (
        ${input.sessionId},
        ${input.runId ?? null},
        ${counter.sequence},
        ${input.type},
        ${JSON.stringify(input.payload ?? {})}::jsonb
      )
      RETURNING id, session_id, run_id, sequence, type, payload, created_at
    `;
    return created;
  });

  const event: SessionEvent = {
    id: String(row.id),
    sessionId: row.session_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
  };
  eventHub.publish(event);
  return event;
}

export async function listEvents(sessionId: string, after = 0, limit = 500): Promise<SessionEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.sequence, after)))
    .orderBy(asc(events.sequence))
    .limit(Math.min(limit, 1000));

  return rows.map((row) => ({
    id: String(row.id),
    sessionId: row.sessionId,
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function claimPendingRun(workerId: string) {
  const [claimed] = await sql<
    Array<{
      id: string;
      session_id: string;
      user_message_id: string;
      model: string;
      thinking_level: string;
      max_cost_usd: number;
      max_turns: number;
    }>
  >`
    UPDATE runs
    SET status = 'running',
        worker_id = ${workerId},
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
    WHERE id = (
      SELECT id
      FROM runs
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, session_id, user_message_id, model, thinking_level, max_cost_usd, max_turns
  `;
  return claimed;
}

export async function renewRunLease(runId: string, workerId: string) {
  await db
    .update(runs)
    .set({ leaseExpiresAt: new Date(Date.now() + 5 * 60_000), updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.workerId, workerId)));
}

export async function recoverStaleRuns() {
  const interrupted = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ["running", "cancelling"]));

  for (const run of interrupted) {
    if (run.status === "cancelling") {
      await finishRun({ runId: run.id, status: "cancelled", error: "Cancelled before the worker restarted" });
      continue;
    }

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, run.sessionId))
      .limit(1);
    const leaf = session?.currentLeafMessageId
      ? (await db.select().from(messages).where(eq(messages.id, session.currentLeafMessageId)).limit(1))[0]
      : undefined;

    let assistantHadNoTools = false;
    if (leaf?.role === "assistant") {
      const calls = await db
        .select()
        .from(messageBlocks)
        .where(and(eq(messageBlocks.messageId, leaf.id), eq(messageBlocks.type, "tool_call")))
        .orderBy(asc(messageBlocks.position));
      assistantHadNoTools = calls.length === 0;
      let parentMessageId: string | null = leaf.id;
      for (const call of calls) {
        const recovered = await createAgentMessage({
          sessionId: run.sessionId,
          runId: run.id,
          parentMessageId,
          role: "tool",
          blocks: [
            {
              type: "tool_result",
              text: "The worker restarted before this tool completed. Inspect the workspace and retry safely if needed.",
              data: {
                callId: String(call.data.callId ?? call.id),
                toolName: String(call.data.name ?? "unknown"),
                isError: true,
              },
              visibility: "model",
            },
          ],
        });
        parentMessageId = recovered.id;
      }
    }

    const [updatedSession] = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, run.sessionId))
      .limit(1);
    const queuedMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.runId, run.id), eq(messages.status, "queued")))
      .orderBy(asc(messages.createdAt));
    let queuedParent = updatedSession?.currentLeafMessageId ?? null;
    for (const queued of queuedMessages) {
      const activated = await activateQueuedMessage({ messageId: queued.id, parentMessageId: queuedParent });
      queuedParent = activated.id;
    }

    if (assistantHadNoTools && queuedMessages.length === 0) {
      await finishRun({ runId: run.id, status: "completed" });
      continue;
    }

    await db
      .update(toolExecutions)
      .set({ status: "failed", completedAt: new Date(), result: { error: "Worker restarted" } })
      .where(and(eq(toolExecutions.runId, run.id), eq(toolExecutions.status, "running")));
    await db
      .update(runs)
      .set({ status: "pending", workerId: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(runs.id, run.id));
  }
}

export async function finishRun(input: {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}) {
  await db
    .update(runs)
    .set({
      status: input.status,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      costUsd: input.costUsd ?? 0,
      error: input.error,
      completedAt: new Date(),
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(runs.id, input.runId));
}

export async function getRun(runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return run;
}

export async function listSessionRuns(sessionId: string) {
  return db.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(desc(runs.createdAt));
}

export async function markRunCancelling(runId: string) {
  const [run] = await db
    .update(runs)
    .set({ status: "cancelling", updatedAt: new Date() })
    .where(and(eq(runs.id, runId), ne(runs.status, "completed")))
    .returning();
  return run;
}

export async function startToolExecution(input: {
  runId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}) {
  const [tool] = await db
    .insert(toolExecutions)
    .values({
      runId: input.runId,
      callId: input.callId,
      toolName: input.toolName,
      arguments: input.arguments,
    })
    .onConflictDoUpdate({
      target: [toolExecutions.runId, toolExecutions.callId],
      set: { status: "running", arguments: input.arguments, startedAt: new Date() },
    })
    .returning();
  return tool;
}

export async function finishToolExecution(input: {
  runId: string;
  callId: string;
  status: "completed" | "failed";
  result: Record<string, unknown>;
  exitCode?: number;
}) {
  await db
    .update(toolExecutions)
    .set({
      status: input.status,
      result: input.result,
      exitCode: input.exitCode,
      completedAt: new Date(),
    })
    .where(and(eq(toolExecutions.runId, input.runId), eq(toolExecutions.callId, input.callId)));
}

export async function saveCheckpoint(input: {
  sessionId: string;
  runId?: string;
  baseCommit: string;
  checkpointCommit: string;
  internalRef: string;
}) {
  const [checkpoint] = await db.insert(chatCheckpoints).values(input).returning();
  return checkpoint;
}

export async function getLatestCheckpointForSession(sessionId: string) {
  const [result] = await db
    .select({ checkpoint: chatCheckpoints })
    .from(chatCheckpoints)
    .where(eq(chatCheckpoints.sessionId, sessionId))
    .orderBy(desc(chatCheckpoints.createdAt))
    .limit(1);
  return result?.checkpoint;
}

export async function getCheckpointForSession(sessionId: string, checkpointCommit: string) {
  const [result] = await db
    .select({ checkpoint: chatCheckpoints })
    .from(chatCheckpoints)
    .where(and(eq(chatCheckpoints.sessionId, sessionId), eq(chatCheckpoints.checkpointCommit, checkpointCommit)))
    .orderBy(desc(chatCheckpoints.createdAt))
    .limit(1);
  return result?.checkpoint;
}

export type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;

export async function createContextSnapshot(input: {
  sessionId: string;
  throughMessageId: string;
  firstPreservedMessageId: string;
  previousSnapshotId?: string | null;
  summary: string;
  model: string;
  reason: string;
  promptVersion: string;
  tokensBefore: number;
  tokensAfter: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}) {
  const [snapshot] = await db
    .insert(contextSnapshots)
    .values({ ...input, previousSnapshotId: input.previousSnapshotId ?? null })
    .returning();
  return snapshot;
}

/** Newest first. The caller picks the snapshot that belongs to the branch it is replaying. */
export async function listContextSnapshots(sessionId: string, limit = 50): Promise<ContextSnapshotRow[]> {
  return db
    .select()
    .from(contextSnapshots)
    .where(eq(contextSnapshots.sessionId, sessionId))
    .orderBy(desc(contextSnapshots.createdAt))
    .limit(limit);
}

export async function savePullRequest(input: {
  sessionId: string;
  repositoryId: string;
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
  headBranch: string;
  baseBranch: string;
  headCommit: string;
}) {
  const [pullRequest] = await db
    .insert(pullRequests)
    .values(input)
    .onConflictDoUpdate({
      target: [pullRequests.sessionId, pullRequests.number],
      set: {
        url: input.url,
        state: input.state,
        draft: input.draft,
        title: input.title,
        headCommit: input.headCommit,
        updatedAt: new Date(),
      },
    })
    .returning();
  return pullRequest;
}

export async function listPullRequests(sessionId: string) {
  return db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.sessionId, sessionId))
    .orderBy(desc(pullRequests.createdAt));
}

export async function saveArtifact(input: {
  id?: string;
  sessionId: string;
  runId?: string;
  messageId?: string;
  name: string;
  type: string;
  mimeType?: string;
  storagePath: string;
  size?: number;
  metadata?: Record<string, unknown>;
}) {
  const [artifact] = await db.insert(artifacts).values(input).returning();
  return artifact;
}

export async function listArtifactsForUser(sessionId: string, userId: string) {
  return db
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(chatSessions, eq(artifacts.sessionId, chatSessions.id))
    .innerJoin(repositories, eq(chatSessions.repositoryId, repositories.id))
    .where(and(eq(artifacts.sessionId, sessionId), eq(repositories.ownerUserId, userId)))
    .orderBy(desc(artifacts.createdAt))
    .then((rows) => rows.map((row) => row.artifact));
}

export function newWorkerId(): string {
  return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
}
