import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { z } from "zod";
import { auth } from "./auth/auth.js";
import { authenticatedUser, requireAuthentication } from "./auth/session.js";
import { config, githubAppConfigured, githubWebhookConfigured } from "./config.js";
import { errorForLog, httpLogger, logger } from "./logger.js";
import {
  GitHubAppNotConfiguredError,
  GitHubInstallationUnavailableError,
  githubApp,
  installationPageUrl,
} from "./github/app.js";
import { createInstallationState, verifyInstallationState } from "./github/installation-state.js";
import { withRepositoryGitAccess } from "./github/repository-access.js";
import { handleWebhookEvent, verifyWebhookSignature } from "./github/webhook.js";
import {
  getGithubInstallationForUser,
  linkUserToGithubInstallation,
  listGithubInstallationsForUser,
  upsertGithubInstallation,
} from "./db/github-store.js";
import {
  createRepository,
  createQueuedUserMessage,
  createSession,
  createUserMessageAndRun,
  deleteQueuedMessage,
  findRepositoryByGithubId,
  finishRun,
  getActiveBranchMessages,
  getActiveRunForSession,
  getArtifactForUser,
  getCheckpointForSession,
  getLatestCheckpointForSession,
  getRepositoryForUser,
  getRunForUser,
  getSessionForUser,
  listEvents,
  listPullRequests,
  listRepositories,
  listSessionRuns,
  listSessions,
  markRunCancelling,
  updateRepositoryFetched,
  updateSessionEnvironment,
  updateSessionTitle,
  type Access,
  type RepositoryRow,
  type SessionRelation,
} from "./db/store.js";
import { eventHub } from "./events/event-hub.js";
import { activeRuns } from "./runtime/agent-runner.js";
import { chatBranchName, validateRepositoryUrl, workspaceManager } from "./runtime/workspace-manager.js";

const apiLogger = logger.child({ component: "api" });

const publicRepositoryInput = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryUrl: z.string().url(),
  defaultBranch: z.string().trim().min(1).max(200).default("main"),
});

const githubRepositoryInput = z.object({
  installationId: z.coerce.number().int().positive(),
  githubRepositoryId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
});

const sessionInput = z.object({
  title: z.string().trim().min(1).max(120).default("New session"),
  model: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).max(200).optional(),
});

const sessionTitleInput = z.object({
  title: z.string().trim().min(1).max(120),
});

const messageInput = z.object({
  text: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).optional(),
  parentMessageId: z.string().uuid().nullable().optional(),
});

const installationIdInput = z.coerce.number().int().positive();

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

function resolveAccess<T>(access: Access<T>, response: Response, missing: string): T | null {
  if (access.status === "ok") return access.value;
  if (access.status === "forbidden") {
    response.status(403).json({ error: "You do not have access to this resource" });
    return null;
  }
  response.status(404).json({ error: missing });
  return null;
}

async function requireRepository(request: Request, response: Response): Promise<RepositoryRow | null> {
  const access = await getRepositoryForUser(routeParam(request, "repositoryId"), authenticatedUser(request).id);
  return resolveAccess(access, response, "Repository not found");
}

async function requireSession(request: Request, response: Response): Promise<SessionRelation | null> {
  const access = await getSessionForUser(routeParam(request, "sessionId"), authenticatedUser(request).id);
  return resolveAccess(access, response, "Session not found");
}

function appRedirect(searchParameters: Record<string, string>): string {
  const destination = new URL("/", config.APP_URL);
  for (const [key, value] of Object.entries(searchParameters)) destination.searchParams.set(key, value);
  return destination.toString();
}

async function chatCheckout(relation: SessionRelation, userId: string) {
  return withRepositoryGitAccess({ repository: relation.repository, userId }, (gitEnvironment) =>
    workspaceManager.ensureChatCheckout({
      chatId: relation.session.id,
      repositoryId: relation.repository.id,
      repositoryUrl: relation.repository.repositoryUrl,
      baseBranch: relation.session.baseBranch,
      branchName: relation.session.branchName,
      headCommit: relation.session.headCommit as string,
      legacyWorkspaceId: typeof relation.session.settings.legacy_workspace_id === "string"
        ? relation.session.settings.legacy_workspace_id
        : undefined,
      gitEnvironment,
    }),
  );
}

async function checkpointRange(relation: SessionRelation, request: Request, response: Response) {
  const sessionId = relation.session.id;
  const requestedCommit = typeof request.query.commit === "string"
    ? z.string().regex(/^[0-9a-f]{40}$/i).parse(request.query.commit)
    : undefined;
  const checkpoint = requestedCommit
    ? await getCheckpointForSession(sessionId, requestedCommit)
    : await getLatestCheckpointForSession(sessionId);
  if (requestedCommit && !checkpoint) {
    response.status(404).json({ error: "Checkpoint not found" });
    return null;
  }
  return { requestedCommit, checkpoint };
}

export function createApi() {
  const app = express();
  app.disable("x-powered-by");
  app.use(httpLogger);

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.post(
    "/api/github/webhook",
    express.raw({ type: "*/*", limit: "1mb" }),
    asyncRoute(async (request, response) => {
      if (!githubWebhookConfigured) {
        response.status(503).json({ error: "GitHub webhooks are not configured" });
        return;
      }

      const signature = request.header("x-hub-signature-256") ?? undefined;
      const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
      if (!body || !(await verifyWebhookSignature({ body, signature }))) {
        apiLogger.warn({ hasSignature: Boolean(signature) }, "Rejected a GitHub webhook with an invalid signature");
        response.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      const event = request.header("x-github-event") ?? "";
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        response.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      const outcome = await handleWebhookEvent({ event, payload });
      response.json({ outcome });
    }),
  );

  app.get(
    "/api/github/installations/callback",
    asyncRoute(async (request, response) => {
      const state = typeof request.query.state === "string" ? request.query.state : "";
      const verified = verifyInstallationState(state);
      if (!verified) {
        apiLogger.warn("Rejected a GitHub installation callback with an invalid state");
        response.redirect(appRedirect({ github_error: "invalid_state" }));
        return;
      }

      if (request.query.setup_action === "request") {
        response.redirect(appRedirect({ github_error: "approval_required" }));
        return;
      }

      const installationId = Number(request.query.installation_id);
      if (!Number.isFinite(installationId) || installationId <= 0) {
        response.redirect(appRedirect({ github_error: "missing_installation" }));
        return;
      }

      try {
        const metadata = await githubApp.getInstallation(installationId);
        const installation = await upsertGithubInstallation({
          installationId: metadata.installationId,
          accountId: metadata.accountId,
          accountLogin: metadata.accountLogin,
          accountType: metadata.accountType,
          repositorySelection: metadata.repositorySelection,
          status: metadata.suspended ? "suspended" : "active",
        });
        await linkUserToGithubInstallation({ installationId: installation.id, userId: verified.userId });
        response.redirect(appRedirect({ github_installation: String(metadata.installationId) }));
      } catch (error) {
        apiLogger.error({ error: errorForLog(error) }, "GitHub installation callback failed");
        response.redirect(appRedirect({ github_error: "installation_unavailable" }));
      }
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", requireAuthentication);

  app.get(
    "/api/repositories",
    asyncRoute(async (request, response) => {
      response.json({ repositories: await listRepositories(authenticatedUser(request).id) });
    }),
  );

  app.post(
    "/api/repositories",
    asyncRoute(async (request, response) => {
      const user = authenticatedUser(request);
      const body = request.body as Record<string, unknown>;

      if (body?.githubRepositoryId !== undefined) {
        const input = githubRepositoryInput.parse(body);
        const installation = await getGithubInstallationForUser({
          installationId: input.installationId,
          userId: user.id,
        });
        if (!installation) {
          response.status(403).json({ error: "You do not have access to this GitHub App installation" });
          return;
        }
        if (installation.status !== "active") {
          response.status(409).json({ error: "That GitHub App installation is not active" });
          return;
        }

        const existing = await findRepositoryByGithubId({
          ownerUserId: user.id,
          githubRepositoryId: input.githubRepositoryId,
        });
        if (existing) {
          response.status(200).json({ repository: existing });
          return;
        }

        const available = await githubApp.listInstallationRepositories(installation.installationId);
        const selected = available.find((entry) => entry.githubRepositoryId === input.githubRepositoryId);
        if (!selected) {
          response.status(404).json({ error: "That repository is not available to this installation" });
          return;
        }

        validateRepositoryUrl(selected.cloneUrl);
        const repositoryId = randomUUID();
        const baseBranch = input.defaultBranch ?? selected.defaultBranch;
        const draft: RepositoryRow = {
          id: repositoryId,
          ownerUserId: user.id,
          name: input.name ?? selected.name,
          repositoryUrl: selected.cloneUrl,
          defaultBranch: baseBranch,
          githubRepositoryId: selected.githubRepositoryId,
          githubInstallationId: installation.id,
          githubFullName: selected.fullName,
          githubOwnerLogin: selected.ownerLogin,
          githubPrivate: selected.private,
          githubCloneUrl: selected.cloneUrl,
          githubAccess: "granted",
          lastFetchedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await withRepositoryGitAccess({ repository: draft, userId: user.id }, (gitEnvironment) =>
          workspaceManager.prepareRepository({
            repositoryId,
            repositoryUrl: selected.cloneUrl,
            baseBranch,
            gitEnvironment,
          }),
        );

        const repository = await createRepository({
          id: repositoryId,
          ownerUserId: user.id,
          name: draft.name,
          repositoryUrl: selected.cloneUrl,
          defaultBranch: baseBranch,
          githubRepositoryId: selected.githubRepositoryId,
          githubInstallationId: installation.id,
          githubFullName: selected.fullName,
          githubOwnerLogin: selected.ownerLogin,
          githubPrivate: selected.private,
          githubCloneUrl: selected.cloneUrl,
        });
        await updateRepositoryFetched(repository.id);
        response.status(201).json({ repository });
        return;
      }

      const input = publicRepositoryInput.parse(body);
      validateRepositoryUrl(input.repositoryUrl);
      const repositoryId = randomUUID();
      await workspaceManager.prepareRepository({
        repositoryId,
        repositoryUrl: input.repositoryUrl,
        baseBranch: input.defaultBranch,
      });
      const repository = await createRepository({ id: repositoryId, ownerUserId: user.id, ...input });
      await updateRepositoryFetched(repository.id);
      response.status(201).json({ repository });
    }),
  );

  app.post(
    "/api/repositories/:repositoryId/chats",
    asyncRoute(async (request, response) => {
      const input = sessionInput.parse(request.body);
      const repository = await requireRepository(request, response);
      if (!repository) return;

      const user = authenticatedUser(request);
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
        const prepared = await withRepositoryGitAccess({ repository, userId: user.id }, (gitEnvironment) =>
          workspaceManager.prepareChat({
            chatId: sessionId,
            repositoryId: repository.id,
            repositoryUrl: repository.repositoryUrl,
            baseBranch,
            branchName,
            gitEnvironment,
          }),
        );
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
      response.json({ sessions: await listSessions(authenticatedUser(request).id, repositoryId) });
    }),
  );

  app.get(
    "/api/sessions/:sessionId",
    asyncRoute(async (request, response) => {
      const relation = await requireSession(request, response);
      if (!relation) return;

      const sessionId = relation.session.id;
      const [sessionMessages, sessionRuns, pullRequests] = await Promise.all([
        getActiveBranchMessages(sessionId),
        listSessionRuns(sessionId),
        listPullRequests(sessionId),
      ]);
      response.json({ ...relation, messages: sessionMessages, runs: sessionRuns, pullRequests });
    }),
  );

  app.patch(
    "/api/sessions/:sessionId",
    asyncRoute(async (request, response) => {
      const input = sessionTitleInput.parse(request.body);
      const relation = await requireSession(request, response);
      if (!relation) return;

      const session = await updateSessionTitle(relation.session.id, input.title);
      response.json({ session });
    }),
  );

  app.get(
    "/api/sessions/:sessionId/changes",
    asyncRoute(async (request, response) => {
      const relation = await requireSession(request, response);
      if (!relation) return;
      if (!relation.session.baseCommit || !relation.session.headCommit) {
        response.status(409).json({ error: "Chat environment is not ready" });
        return;
      }

      const location = await chatCheckout(relation, authenticatedUser(request).id);
      const range = await checkpointRange(relation, request, response);
      if (!range) return;

      const checkpointCommit = range.checkpoint?.checkpointCommit ?? relation.session.headCommit;
      const baseCommit = range.requestedCommit && range.checkpoint
        ? await workspaceManager.parentCommit(location.repository, range.checkpoint.checkpointCommit)
        : range.checkpoint?.baseCommit ?? relation.session.baseCommit;
      const changes = await workspaceManager.codeChanges(location.repository, baseCommit, checkpointCommit);
      response.json({ changes });
    }),
  );

  app.get(
    "/api/sessions/:sessionId/changes.patch",
    asyncRoute(async (request, response) => {
      const relation = await requireSession(request, response);
      if (!relation) return;
      if (!relation.session.baseCommit || !relation.session.headCommit) {
        response.status(409).json({ error: "Chat environment is not ready" });
        return;
      }

      const location = await chatCheckout(relation, authenticatedUser(request).id);
      const range = await checkpointRange(relation, request, response);
      if (!range) return;

      const checkpointCommit = range.checkpoint?.checkpointCommit ?? relation.session.headCommit;
      const baseCommit = range.requestedCommit && range.checkpoint
        ? await workspaceManager.parentCommit(location.repository, range.checkpoint.checkpointCommit)
        : range.checkpoint?.baseCommit ?? relation.session.baseCommit;
      const patch = await workspaceManager.patch(location.repository, baseCommit, checkpointCommit);
      response.setHeader("Content-Disposition", 'attachment; filename="changes.patch"');
      response.type("text/x-diff").send(patch);
    }),
  );

  app.get(
    "/api/sessions/:sessionId/artifacts/:artifactId",
    asyncRoute(async (request, response) => {
      const relation = await requireSession(request, response);
      if (!relation) return;

      const access = await getArtifactForUser(routeParam(request, "artifactId"), authenticatedUser(request).id);
      const artifact = resolveAccess(access, response, "Artifact not found");
      if (!artifact) return;
      if (artifact.sessionId !== relation.session.id) {
        response.status(404).json({ error: "Artifact not found" });
        return;
      }

      response.type(artifact.mimeType ?? "application/octet-stream");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      response.sendFile(artifact.storagePath, (error) => {
        if (error && !response.headersSent) response.status(404).json({ error: "Artifact not found" });
      });
    }),
  );

  app.post(
    "/api/sessions/:sessionId/messages",
    asyncRoute(async (request, response) => {
      const input = messageInput.parse(request.body);
      const relation = await requireSession(request, response);
      if (!relation) return;

      const sessionId = relation.session.id;
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
      const relation = await requireSession(request, response);
      if (!relation) return;

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

      const sessionId = relation.session.id;
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
      const access = await getRunForUser(routeParam(request, "runId"), authenticatedUser(request).id);
      const run = resolveAccess(access, response, "Run not found");
      if (!run) return;

      await markRunCancelling(run.id);
      const cancelledLive = activeRuns.cancel(run.id);
      if (!cancelledLive) await finishRun({ runId: run.id, status: "cancelled" });
      response.json({ cancelled: true });
    }),
  );

  app.get(
    "/api/github/status",
    asyncRoute(async (_request, response) => {
      response.json({ appConfigured: githubAppConfigured, webhooksConfigured: githubWebhookConfigured });
    }),
  );

  app.post(
    "/api/github/installations/start",
    asyncRoute(async (request, response) => {
      const state = createInstallationState(authenticatedUser(request).id);
      response.json({ url: installationPageUrl(state) });
    }),
  );

  app.get(
    "/api/github/installations",
    asyncRoute(async (request, response) => {
      const installations = await listGithubInstallationsForUser(authenticatedUser(request).id);
      response.json({
        installations: installations.map((installation) => ({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          status: installation.status,
        })),
      });
    }),
  );

  app.get(
    "/api/github/installations/:installationId/repositories",
    asyncRoute(async (request, response) => {
      const installationId = installationIdInput.parse(routeParam(request, "installationId"));
      const installation = await getGithubInstallationForUser({
        installationId,
        userId: authenticatedUser(request).id,
      });
      if (!installation) {
        response.status(403).json({ error: "You do not have access to this GitHub App installation" });
        return;
      }
      if (installation.status !== "active") {
        response.status(409).json({ error: "That GitHub App installation is not active", status: installation.status });
        return;
      }

      const repositories = await githubApp.listInstallationRepositories(installationId);
      response.json({ repositories });
    }),
  );

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      request.log.warn({ issueCount: error.issues.length }, "Request validation failed");
      response.status(400).json({ error: "The request could not be validated" });
      return;
    }

    request.log.error({ error: errorForLog(error) }, "API request failed");

    if (error instanceof GitHubAppNotConfiguredError) {
      response.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof GitHubInstallationUnavailableError) {
      response.status(409).json({ error: error.message });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = message.includes("active run") ? 409 : 500;
    response.status(status).json({ error: message });
  });

  return app;
}
