import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import { errorForLog, httpLogger } from "./logger.js";
import {
  createRepository,
  createQueuedUserMessage,
  createSession,
  createUserMessageAndRun,
  deleteQueuedMessage,
  finishRun,
  getActiveBranchMessages,
  getActiveRunForSession,
  getCheckpointForSession,
  getLatestCheckpointForSession,
  getPendingApprovals,
  getRun,
  getSession,
  listEvents,
  getRepository,
  listRepositories,
  listSessionRuns,
  listSessions,
  markRunCancelling,
  resolveApproval,
  updateRepositoryFetched,
  updateSessionEnvironment,
} from "./db/store.js";
import { eventHub } from "./events/event-hub.js";
import { activeRuns } from "./runtime/agent-runner.js";
import { approvalBroker } from "./runtime/approval-broker.js";
import { chatBranchName, validateRepositoryUrl, workspaceManager } from "./runtime/workspace-manager.js";

const repositoryInput = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryUrl: z.string().url(),
  defaultBranch: z.string().trim().min(1).max(200).default("main"),
});

const sessionInput = z.object({
  title: z.string().trim().min(1).max(120).default("New session"),
  model: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).max(200).optional(),
});

const messageInput = z.object({
  text: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
});

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") throw new Error(`Missing route parameter: ${name}`);
  return value;
}

export function createApi() {
  const app = express();
  app.disable("x-powered-by");
  app.use(httpLogger);
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get(
    "/api/repositories",
    asyncRoute(async (_request, response) => {
      response.json({ repositories: await listRepositories() });
    }),
  );

  app.post(
    "/api/repositories",
    asyncRoute(async (request, response) => {
      const input = repositoryInput.parse(request.body);
      validateRepositoryUrl(input.repositoryUrl);
      const repositoryId = randomUUID();
      await workspaceManager.prepareRepository({
        repositoryId,
        repositoryUrl: input.repositoryUrl,
        baseBranch: input.defaultBranch,
      });
      const repository = await createRepository({ id: repositoryId, ...input });
      await updateRepositoryFetched(repository.id);
      response.status(201).json({ repository });
    }),
  );

  app.post(
    "/api/repositories/:repositoryId/chats",
    asyncRoute(async (request, response) => {
      const input = sessionInput.parse(request.body);
      const repository = await getRepository(routeParam(request, "repositoryId"));
      if (!repository) {
        response.status(404).json({ error: "Repository not found" });
        return;
      }

      const sessionId = randomUUID();
      const baseBranch = input.baseBranch ?? repository.defaultBranch;
      const branchName = chatBranchName(sessionId);
      const session = await createSession({
        id: sessionId,
        repositoryId: repository.id,
        title: input.title,
        model: input.model,
        baseBranch,
        branchName,
      });

      try {
        const prepared = await workspaceManager.prepareChat({
          chatId: sessionId,
          repositoryId: repository.id,
          repositoryUrl: repository.repositoryUrl,
          baseBranch,
          branchName,
        });
        const ready = await updateSessionEnvironment({
          sessionId,
          envStatus: "ready",
          baseCommit: prepared.baseCommit,
          headCommit: prepared.headCommit,
        });
        await updateRepositoryFetched(repository.id);
        response.status(201).json({ session: ready });
      } catch (error) {
        await updateSessionEnvironment({ sessionId, envStatus: "failed" });
        throw error;
      }
    }),
  );

  app.get(
    "/api/sessions",
    asyncRoute(async (request, response) => {
      const repositoryId = typeof request.query.repositoryId === "string" ? request.query.repositoryId : undefined;
      response.json({ sessions: await listSessions(repositoryId) });
    }),
  );

  app.get(
    "/api/sessions/:sessionId",
    asyncRoute(async (request, response) => {
      const sessionId = routeParam(request, "sessionId");
      const relation = await getSession(sessionId);
      if (!relation) {
        response.status(404).json({ error: "Session not found" });
        return;
      }

      const [sessionMessages, sessionRuns, approvals] = await Promise.all([
        getActiveBranchMessages(sessionId),
        listSessionRuns(sessionId),
        getPendingApprovals(sessionId),
      ]);
      response.json({ ...relation, messages: sessionMessages, runs: sessionRuns, approvals });
    }),
  );

  app.get(
    "/api/sessions/:sessionId/changes",
    asyncRoute(async (request, response) => {
      const sessionId = routeParam(request, "sessionId");
      const relation = await getSession(sessionId);
      if (!relation) {
        response.status(404).json({ error: "Session not found" });
        return;
      }
      if (!relation.session.baseCommit || !relation.session.headCommit) {
        response.status(409).json({ error: "Chat environment is not ready" });
        return;
      }

      const location = await workspaceManager.ensureChatCheckout({
        chatId: relation.session.id,
        repositoryId: relation.repository.id,
        repositoryUrl: relation.repository.repositoryUrl,
        baseBranch: relation.session.baseBranch,
        branchName: relation.session.branchName,
        headCommit: relation.session.headCommit,
        legacyWorkspaceId: typeof relation.session.settings.legacy_workspace_id === "string"
          ? relation.session.settings.legacy_workspace_id
          : undefined,
      });

      const requestedCommit = typeof request.query.commit === "string"
        ? z.string().regex(/^[0-9a-f]{40}$/i).parse(request.query.commit)
        : undefined;
      const checkpoint = requestedCommit
        ? await getCheckpointForSession(sessionId, requestedCommit)
        : await getLatestCheckpointForSession(sessionId);
      if (requestedCommit && !checkpoint) {
        response.status(404).json({ error: "Checkpoint not found" });
        return;
      }
      const checkpointCommit = checkpoint?.checkpointCommit ?? relation.session.headCommit;
      const baseCommit = requestedCommit && checkpoint
        ? await workspaceManager.parentCommit(location.repository, checkpoint.checkpointCommit)
        : checkpoint?.baseCommit ?? relation.session.baseCommit;
      const changes = await workspaceManager.codeChanges(
        location.repository,
        baseCommit,
        checkpointCommit,
      );
      response.json({ changes });
    }),
  );

  app.get(
    "/api/sessions/:sessionId/changes.patch",
    asyncRoute(async (request, response) => {
      const sessionId = routeParam(request, "sessionId");
      const relation = await getSession(sessionId);
      if (!relation) {
        response.status(404).json({ error: "Session not found" });
        return;
      }
      if (!relation.session.baseCommit || !relation.session.headCommit) {
        response.status(409).json({ error: "Chat environment is not ready" });
        return;
      }

      const location = await workspaceManager.ensureChatCheckout({
        chatId: relation.session.id,
        repositoryId: relation.repository.id,
        repositoryUrl: relation.repository.repositoryUrl,
        baseBranch: relation.session.baseBranch,
        branchName: relation.session.branchName,
        headCommit: relation.session.headCommit,
        legacyWorkspaceId: typeof relation.session.settings.legacy_workspace_id === "string"
          ? relation.session.settings.legacy_workspace_id
          : undefined,
      });

      const requestedCommit = typeof request.query.commit === "string"
        ? z.string().regex(/^[0-9a-f]{40}$/i).parse(request.query.commit)
        : undefined;
      const checkpoint = requestedCommit
        ? await getCheckpointForSession(sessionId, requestedCommit)
        : await getLatestCheckpointForSession(sessionId);
      if (requestedCommit && !checkpoint) {
        response.status(404).json({ error: "Checkpoint not found" });
        return;
      }
      const checkpointCommit = checkpoint?.checkpointCommit ?? relation.session.headCommit;
      const baseCommit = requestedCommit && checkpoint
        ? await workspaceManager.parentCommit(location.repository, checkpoint.checkpointCommit)
        : checkpoint?.baseCommit ?? relation.session.baseCommit;
      const patch = await workspaceManager.patch(
        location.repository,
        baseCommit,
        checkpointCommit,
      );
      response.setHeader("Content-Disposition", 'attachment; filename="changes.patch"');
      response.type("text/x-diff").send(patch);
    }),
  );

  app.post(
    "/api/sessions/:sessionId/messages",
    asyncRoute(async (request, response) => {
      const input = messageInput.parse(request.body);
      const sessionId = routeParam(request, "sessionId");
      const active = await getActiveRunForSession(sessionId);

      if (active) {
        if (!activeRuns.has(active.id)) {
          response.status(409).json({ error: "The active run is starting. Send this message again in a moment." });
          return;
        }
        const message = await createQueuedUserMessage({ sessionId, runId: active.id, text: input.text });
        if (!activeRuns.steer(active.id, message.id, input.text)) {
          await deleteQueuedMessage(message.id);
          response.status(409).json({ error: "The run finished while this message was being queued. Send it again." });
          return;
        }
        response.status(202).json({ message, run: active, steering: true });
        return;
      }

      const created = await createUserMessageAndRun({ sessionId, ...input });
      response.status(202).json(created);
    }),
  );

  app.get(
    "/api/sessions/:sessionId/events",
    asyncRoute(async (request, response) => {
      const afterHeader = Number(request.headers["last-event-id"] ?? 0);
      const afterQuery = Number(request.query.after ?? 0);
      let lastSequence = Number.isFinite(afterQuery) ? Math.max(afterHeader, afterQuery) : afterHeader;
      const pending: Awaited<ReturnType<typeof listEvents>> = [];
      let replaying = true;

      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      const send = (event: Awaited<ReturnType<typeof listEvents>>[number]) => {
        if (event.transient) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
          return;
        }
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        response.write(`id: ${event.sequence}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const sessionId = routeParam(request, "sessionId");
      const unsubscribe = eventHub.subscribe(sessionId, (event) => {
        if (replaying) pending.push(event);
        else send(event);
      });

      const backlog = await listEvents(sessionId, lastSequence, 1000);
      backlog.forEach(send);
      replaying = false;
      pending.sort((a, b) => a.sequence - b.sequence).forEach(send);
      response.write("event: ready\ndata: {}\n\n");

      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      });
    }),
  );

  app.post(
    "/api/runs/:runId/cancel",
    asyncRoute(async (request, response) => {
      const run = await getRun(routeParam(request, "runId"));
      if (!run) {
        response.status(404).json({ error: "Run not found" });
        return;
      }

      await markRunCancelling(run.id);
      const cancelledLive = activeRuns.cancel(run.id);
      if (!cancelledLive) await finishRun({ runId: run.id, status: "cancelled" });
      response.json({ cancelled: true });
    }),
  );

  app.post(
    "/api/approvals/:approvalId",
    asyncRoute(async (request, response) => {
      const input = z.object({ approved: z.boolean() }).parse(request.body);
      const approval = await resolveApproval(routeParam(request, "approvalId"), input.approved);
      if (!approval) {
        response.status(404).json({ error: "Pending approval not found" });
        return;
      }
      approvalBroker.resolve(approval.id, input.approved);
      response.json({ approval });
    }),
  );

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = error instanceof z.ZodError ? 400 : message.includes("active run") ? 409 : 500;
    if (error instanceof z.ZodError) {
      request.log.warn({ issueCount: error.issues.length }, "Request validation failed");
    } else {
      request.log.error({ error: errorForLog(error) }, "API request failed");
    }
    response.status(status).json({ error: message });
  });

  return app;
}
