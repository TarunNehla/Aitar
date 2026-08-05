import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { MessageView, SessionEvent } from "../../shared/contracts.js";
import { config } from "../config.js";
import { eventHub } from "../events/event-hub.js";
import { db, sql } from "./client.js";
import {
  approvalRequests,
  artifacts,
  chatSessions,
  events,
  messageBlocks,
  messages,
  projects,
  runs,
  toolExecutions,
  workspaceCheckpoints,
  workspaces,
} from "./schema.js";

export async function createProject(input: { name: string; repositoryUrl: string }) {
  const [project] = await db.insert(projects).values(input).returning();
  return project;
}

export async function listProjects() {
  return db.select().from(projects).orderBy(desc(projects.updatedAt));
}

export async function createWorkspace(input: {
  id: string;
  projectId: string;
  name: string;
  baseBranch: string;
  localPath: string;
}) {
  const [workspace] = await db.insert(workspaces).values(input).returning();
  return workspace;
}

export async function updateWorkspaceReady(workspaceId: string, baseCommit: string) {
  const [workspace] = await db
    .update(workspaces)
    .set({ baseCommit, status: "ready", updatedAt: new Date(), lastActiveAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return workspace;
}

export async function updateWorkspaceStatus(workspaceId: string, status: string) {
  await db
    .update(workspaces)
    .set({ status, updatedAt: new Date(), lastActiveAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}

export async function getWorkspace(workspaceId: string) {
  const [workspace] = await db
    .select({ workspace: workspaces, project: projects })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace;
}

export async function listWorkspaces(projectId?: string) {
  const query = db
    .select({ workspace: workspaces, project: projects })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id));
  return projectId
    ? query.where(eq(workspaces.projectId, projectId)).orderBy(desc(workspaces.updatedAt))
    : query.orderBy(desc(workspaces.updatedAt));
}

export async function createSession(input: { workspaceId: string; title: string; model?: string }) {
  const [session] = await db
    .insert(chatSessions)
    .values({
      workspaceId: input.workspaceId,
      title: input.title,
      defaultModel: input.model ?? config.OPENROUTER_MODEL,
    })
    .returning();
  return session;
}

export async function listSessions(workspaceId?: string) {
  const query = db
    .select({ session: chatSessions, workspace: workspaces, project: projects })
    .from(chatSessions)
    .innerJoin(workspaces, eq(chatSessions.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id));
  return workspaceId
    ? query.where(eq(chatSessions.workspaceId, workspaceId)).orderBy(desc(chatSessions.updatedAt))
    : query.orderBy(desc(chatSessions.updatedAt));
}

export async function getSession(sessionId: string) {
  const [result] = await db
    .select({ session: chatSessions, workspace: workspaces, project: projects })
    .from(chatSessions)
    .innerJoin(workspaces, eq(chatSessions.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return result;
}

export async function createUserMessageAndRun(input: {
  sessionId: string;
  text: string;
  model?: string;
  parentMessageId?: string | null;
}) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, input.sessionId))
      .limit(1);

    if (!session) {
      throw new Error("Session not found");
    }

    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(chatSessions, eq(runs.sessionId, chatSessions.id))
      .where(
        and(
          eq(chatSessions.workspaceId, session.workspaceId),
          inArray(runs.status, ["pending", "running", "waiting_for_approval", "cancelling"]),
        ),
      )
      .limit(1);

    if (active.length > 0) {
      throw new Error("This workspace already has an active run");
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
        workspaceId: session.workspaceId,
        userMessageId: message.id,
        model: input.model ?? session.defaultModel,
        maxCostUsd: config.RUN_MAX_COST_USD,
        maxTurns: config.RUN_MAX_TURNS,
      })
      .returning();

    await tx.update(messages).set({ runId: run.id }).where(eq(messages.id, message.id));
    await tx
      .update(chatSessions)
      .set({ currentLeafMessageId: message.id, updatedAt: new Date() })
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
        inArray(runs.status, ["pending", "running", "waiting_for_approval", "cancelling"]),
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
    Array<{ id: string; session_id: string; user_message_id: string; model: string; max_cost_usd: number; max_turns: number }>
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
    RETURNING id, session_id, user_message_id, model, max_cost_usd, max_turns
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
    .where(inArray(runs.status, ["running", "waiting_for_approval", "cancelling"]));

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
      .update(approvalRequests)
      .set({ status: "expired", resolvedAt: new Date(), resolvedBy: "worker_restart" })
      .where(and(eq(approvalRequests.runId, run.id), eq(approvalRequests.status, "pending")));
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

export async function createApproval(input: {
  sessionId: string;
  runId: string;
  toolExecutionId?: string;
  reason: string;
  command?: string;
}) {
  const [approval] = await db.insert(approvalRequests).values(input).returning();
  await db.update(runs).set({ status: "waiting_for_approval", updatedAt: new Date() }).where(eq(runs.id, input.runId));
  return approval;
}

export async function resolveApproval(id: string, approved: boolean) {
  const [approval] = await db
    .update(approvalRequests)
    .set({
      status: approved ? "approved" : "denied",
      resolvedBy: "user",
      resolvedAt: new Date(),
    })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending")))
    .returning();

  if (approval) {
    await db.update(runs).set({ status: "running", updatedAt: new Date() }).where(eq(runs.id, approval.runId));
  }
  return approval;
}

export async function getPendingApprovals(sessionId: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.sessionId, sessionId), eq(approvalRequests.status, "pending")))
    .orderBy(asc(approvalRequests.createdAt));
}

export async function saveCheckpoint(input: {
  workspaceId: string;
  runId?: string;
  baseCommit: string;
  checkpointCommit: string;
  internalRef: string;
}) {
  const [checkpoint] = await db.insert(workspaceCheckpoints).values(input).returning();
  return checkpoint;
}

export async function getLatestCheckpointForSession(sessionId: string) {
  const [result] = await db
    .select({ checkpoint: workspaceCheckpoints })
    .from(workspaceCheckpoints)
    .innerJoin(runs, eq(workspaceCheckpoints.runId, runs.id))
    .where(eq(runs.sessionId, sessionId))
    .orderBy(desc(workspaceCheckpoints.createdAt))
    .limit(1);
  return result?.checkpoint;
}

export async function getCheckpointForSession(sessionId: string, checkpointCommit: string) {
  const [result] = await db
    .select({ checkpoint: workspaceCheckpoints })
    .from(workspaceCheckpoints)
    .innerJoin(runs, eq(workspaceCheckpoints.runId, runs.id))
    .where(and(eq(runs.sessionId, sessionId), eq(workspaceCheckpoints.checkpointCommit, checkpointCommit)))
    .orderBy(desc(workspaceCheckpoints.createdAt))
    .limit(1);
  return result?.checkpoint;
}

export async function saveArtifact(input: {
  workspaceId: string;
  sessionId?: string;
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

export async function listArtifacts(sessionId: string) {
  return db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId)).orderBy(desc(artifacts.createdAt));
}

export async function getArtifact(artifactId: string) {
  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
  return artifact;
}

export function newWorkerId(): string {
  return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
}
