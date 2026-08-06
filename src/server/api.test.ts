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
  baseBranch: "main",
  branchName: "agent/22222222-2222-4222-8222-222222222222",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  settings: {},
};

const ownedRun = { id: "33333333-3333-4333-8333-333333333333", sessionId: ownedSession.id, status: "running" };

function accessFor<T>(row: T, ownerUserId: string | null, userId: string) {
  if (!ownerUserId) return { status: "not_found" } as const;
  if (ownerUserId !== userId) return { status: "forbidden" } as const;
  return { status: "ok", value: row } as const;
}

vi.mock("./auth/auth.js", () => ({
  auth: {
    api: { getSession: async () => (currentUser ? { user: currentUser, session: { id: "session" } } : null) },
    handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  },
}));

vi.mock("./runtime/agent-runner.js", () => ({
  activeRuns: { has: () => false, steer: () => false, cancel: () => false },
}));

vi.mock("./db/store.js", () => ({
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
  getApprovalForUser: async () => ({ status: "not_found" }),
  listSessions: async (ownerUserId: string) =>
    ownerUserId === owner.id ? [{ session: ownedSession, repository: ownedRepository }] : [],
  getActiveBranchMessages: async () => [],
  listSessionRuns: async () => [],
  getPendingApprovals: async () => [],
  getActiveRunForSession: async () => undefined,
  listEvents: async () => [],
  createRepository: async () => ownedRepository,
  createSession: async () => ownedSession,
  createUserMessageAndRun: async () => ({ message: { id: "message" }, run: ownedRun }),
  createQueuedUserMessage: async () => ({ id: "message" }),
  deleteQueuedMessage: async () => undefined,
  findRepositoryByGithubId: async () => undefined,
  finishRun: async () => undefined,
  getCheckpointForSession: async () => undefined,
  getLatestCheckpointForSession: async () => undefined,
  markRunCancelling: async () => undefined,
  resolveApproval: async () => undefined,
  updateRepositoryFetched: async () => undefined,
  updateSessionEnvironment: async () => ownedSession,
}));

vi.mock("./db/github-store.js", () => ({
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
  const { createApi } = await import("./api.js");
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
});

async function call(path: string, options?: RequestInit) {
  return fetch(`${origin}${path}`, options);
}

describe("API authentication", () => {
  it("keeps the health endpoint public", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
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
