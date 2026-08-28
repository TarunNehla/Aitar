import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const owner = { id: "user-owner", email: "owner@example.com", name: "Owner" };
const intruder = { id: "user-intruder", email: "intruder@example.com", name: "Intruder" };

let currentUser: typeof owner | null = null;

const ownedRepository = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: owner.id,
  name: "Owned",
  repositoryUrl: "https://github.com/owner/owned",
  defaultBranch: "main",
  githubRepositoryId: null,
  githubInstallationId: null,
  githubFullName: null,
  githubOwnerLogin: null,
  githubPrivate: false,
  githubCloneUrl: null,
  githubAccess: "granted",
  lastFetchedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ownedSession = {
  id: "22222222-2222-4222-8222-222222222222",
  repositoryId: ownedRepository.id,
  title: "Owned chat",
  baseBranch: "main",
  publishedBranch: null,
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  envStatus: "ready",
  settings: {},
};

const ownedRun = { id: "33333333-3333-4333-8333-333333333333", sessionId: ownedSession.id, status: "running" };

function accessFor<T>(row: T, ownerUserId: string | null, userId: string) {
  if (!ownerUserId) return { status: "not_found" } as const;
  if (ownerUserId !== userId) return { status: "forbidden" } as const;
  return { status: "ok", value: row } as const;
}

vi.mock("../auth/auth.js", () => ({
  auth: {
    api: { getSession: async () => (currentUser ? { user: currentUser, session: { id: "session" } } : null) },
    handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  },
}));

vi.mock("../runtime/agent/agent-runner.js", () => ({
  activeRuns: { has: () => false, steer: () => false, cancel: () => false },
}));

const ensureChatCheckout = vi.fn(async () => ({
  root: "/tmp/cloud-agents-tests/chats/chat",
  repository: "/tmp/cloud-agents-tests/chats/chat/repository",
  baseCommit: ownedSession.baseCommit,
  headCommit: ownedSession.headCommit,
  created: false,
}));
const prepareRepository = vi.fn(async () => ({
  mirrorPath: "/tmp/cloud-agents-tests/repos/repository.git",
  defaultBranch: "main",
  baseCommit: "a".repeat(40),
}));
const ensureContainer = vi.fn(async () => "cloud-agent-chat");

vi.mock("../runtime/workspace/workspace-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/workspace/workspace-manager.js")>(
    "../runtime/workspace/workspace-manager.js",
  );
  return { ...actual, workspaceManager: { ensureChatCheckout, prepareRepository } };
});

vi.mock("../runtime/sandbox/sandbox.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/sandbox/sandbox.js")>("../runtime/sandbox/sandbox.js");
  return { ...actual, sandbox: { ensureContainer } };
});

const createdSessions: Array<Record<string, unknown>> = [];

vi.mock("../db/store.js", () => ({
  listRepositories: async (ownerUserId: string) =>
    ownerUserId === owner.id ? [ownedRepository] : [],
  getRepositoryForUser: async (repositoryId: string, userId: string) =>
    repositoryId === ownedRepository.id
      ? accessFor(ownedRepository, ownedRepository.ownerUserId, userId)
      : { status: "not_found" },
  getSessionForUser: async (sessionId: string, userId: string) =>
    sessionId === ownedSession.id
      ? accessFor({ session: ownedSession, repository: ownedRepository }, ownedRepository.ownerUserId, userId)
      : { status: "not_found" },
  getRunForUser: async (runId: string, userId: string) =>
    runId === ownedRun.id ? accessFor(ownedRun, ownedRepository.ownerUserId, userId) : { status: "not_found" },
  listSessions: async (ownerUserId: string) =>
    ownerUserId === owner.id ? [{ session: ownedSession, repository: ownedRepository }] : [],
  getActiveBranchMessages: async () => [],
  listSessionRuns: async () => [],
  listPullRequests: async () => [],
  getActiveRunForSession: async () => undefined,
  listEvents: async () => [],
  createRepository: async () => ownedRepository,
  createSession: async (input: Record<string, unknown>) => {
    createdSessions.push(input);
    return { ...ownedSession, ...input };
  },
  createUserMessageAndRun: async () => ({ message: { id: "message" }, run: ownedRun }),
  createQueuedUserMessage: async () => ({ id: "message" }),
  deleteQueuedMessage: async () => undefined,
  findRepositoryByGithubId: async () => undefined,
  finishRun: async () => undefined,
  getCheckpointForSession: async () => undefined,
  getLatestCheckpointForSession: async () => undefined,
  markRunCancelling: async () => undefined,
  updateRepositoryFetched: async () => undefined,
  updateSessionEnvironment: async () => ownedSession,
}));

vi.mock("../db/github-store.js", () => ({
  getGithubInstallationForUser: async () => undefined,
  linkUserToGithubInstallation: async () => undefined,
  listGithubInstallationsForUser: async (userId: string) =>
    userId === owner.id
      ? [{
          installationId: 500,
          accountLogin: "owner",
          accountType: "User",
          repositorySelection: "selected",
          status: "active",
        }]
      : [],
  upsertGithubInstallation: async () => ({ id: "installation" }),
}));

let server: Server;
let origin: string;

beforeAll(async () => {
  const { createApi } = await import("../api.js");
  const app = createApi();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  currentUser = null;
  createdSessions.length = 0;
  ensureChatCheckout.mockClear();
  ensureContainer.mockClear();
});

async function call(path: string, options?: RequestInit) {
  return fetch(`${origin}${path}`, options);
}

describe("API authentication", () => {
  it("keeps the health endpoint public", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
  });

  it("tells a signed-out browser which sign-in methods exist", async () => {
    const response = await call("/api/auth-methods");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ emailPassword: true });
  });

  it("rejects unauthenticated API requests with 401", async () => {
    const paths = [
      "/api/repositories",
      "/api/sessions",
      `/api/sessions/${ownedSession.id}`,
      `/api/sessions/${ownedSession.id}/events`,
      "/api/github/installations",
    ];

    for (const path of paths) {
      const response = await call(path);
      expect(response.status, path).toBe(401);
    }
  });

  it("rejects unauthenticated writes with 401", async () => {
    const response = await call("/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", repositoryUrl: "https://github.com/owner/owned" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("chat creation", () => {
  async function createChat() {
    currentUser = owner;
    return call(`/api/repositories/${ownedRepository.id}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New session" }),
    });
  }

  it("saves the chat with the repository's default branch and nothing else", async () => {
    const response = await createChat();

    expect(response.status).toBe(201);
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]).toMatchObject({ repositoryId: ownedRepository.id, baseBranch: "main" });
    expect(Object.keys(createdSessions[0])).not.toContain("branchName");
    expect(Object.keys(createdSessions[0])).not.toContain("publishedBranch");
  });

  it("prepares no checkout and starts no container for a new chat", async () => {
    await createChat();

    expect(ensureChatCheckout).not.toHaveBeenCalled();
    expect(ensureContainer).not.toHaveBeenCalled();
  });

  it("ignores a base branch the browser tries to choose", async () => {
    currentUser = owner;
    const response = await call(`/api/repositories/${ownedRepository.id}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New session", baseBranch: "release" }),
    });

    expect(response.status).toBe(201);
    expect(createdSessions[0]).toMatchObject({ baseBranch: "main" });
  });
});

describe("branch information stays server side", () => {
  it("sends no branch on a created chat", async () => {
    currentUser = owner;
    const response = await call(`/api/repositories/${ownedRepository.id}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New session" }),
    });
    const body = await response.json();

    expect(body.session.baseBranch).toBeUndefined();
    expect(body.session.publishedBranch).toBeUndefined();
  });

  it("sends no branch on chats, repositories, or pull requests", async () => {
    currentUser = owner;
    const [sessions, detail, repositories] = await Promise.all([
      (await call("/api/sessions")).json(),
      (await call(`/api/sessions/${ownedSession.id}`)).json(),
      (await call("/api/repositories")).json(),
    ]);

    expect(sessions.sessions[0].session.baseBranch).toBeUndefined();
    expect(sessions.sessions[0].repository.defaultBranch).toBeUndefined();
    expect(detail.session.baseBranch).toBeUndefined();
    expect(detail.session.publishedBranch).toBeUndefined();
    expect(detail.repository.defaultBranch).toBeUndefined();
    expect(repositories.repositories[0].defaultBranch).toBeUndefined();
    for (const payload of [sessions, detail, repositories]) {
      expect(JSON.stringify(payload)).not.toContain("agent/");
      expect(JSON.stringify(payload)).not.toContain("refs/");
    }
  });
});

describe("API authorization", () => {
  it("filters repository listings by owner", async () => {
    currentUser = owner;
    const owned = await (await call("/api/repositories")).json();
    expect(owned.repositories).toHaveLength(1);

    currentUser = intruder;
    const empty = await (await call("/api/repositories")).json();
    expect(empty.repositories).toHaveLength(0);
  });

  it("filters chat listings by repository owner", async () => {
    currentUser = intruder;
    const result = await (await call("/api/sessions")).json();
    expect(result.sessions).toHaveLength(0);
  });

  it("rejects cross-user repository access with 403", async () => {
    currentUser = intruder;
    const response = await call(`/api/repositories/${ownedRepository.id}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New session" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects cross-user chat access with 403", async () => {
    currentUser = intruder;
    for (const path of [
      `/api/sessions/${ownedSession.id}`,
      `/api/sessions/${ownedSession.id}/changes`,
      `/api/sessions/${ownedSession.id}/changes.patch`,
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(403);
    }
  });

  it("rejects cross-user message sending with 403", async () => {
    currentUser = intruder;
    const response = await call(`/api/sessions/${ownedSession.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects cross-user SSE subscriptions with 403", async () => {
    currentUser = intruder;
    const response = await call(`/api/sessions/${ownedSession.id}/events`);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    await response.text();
  });

  it("authorises SSE for the owner", async () => {
    currentUser = owner;
    const controller = new AbortController();
    const response = await call(`/api/sessions/${ownedSession.id}/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("rejects cross-user run cancellation with 403", async () => {
    currentUser = intruder;
    const response = await call(`/api/runs/${ownedRun.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("returns 404 for resources that do not exist", async () => {
    currentUser = owner;
    const response = await call("/api/sessions/44444444-4444-4444-8444-444444444444");
    expect(response.status).toBe(404);
  });

  it("rejects GitHub installation repositories for other users with 403", async () => {
    currentUser = intruder;
    const response = await call("/api/github/installations/500/repositories");
    expect(response.status).toBe(403);
  });
});
