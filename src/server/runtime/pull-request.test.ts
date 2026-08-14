import { beforeEach, describe, expect, it, vi } from "vitest";

const token = "ghs_pullrequesttesttoken000000000000";

const repository = {
  id: "repository-1",
  ownerUserId: "user-1",
  name: "service",
  repositoryUrl: "https://github.com/acme/service.git",
  defaultBranch: "main",
  githubRepositoryId: 900,
  githubInstallationId: "installation-1",
  githubFullName: "acme/service",
  githubOwnerLogin: "acme",
  githubPrivate: true,
  githubCloneUrl: "https://github.com/acme/service.git",
  githubAccess: "granted",
};

const session = {
  id: "session-1",
  repositoryId: repository.id,
  baseBranch: "main",
  branchName: "agent/session-1",
  baseCommit: "a".repeat(40),
  headCommit: "a".repeat(40),
};

let relation: { session: typeof session; repository: typeof repository } | undefined;
let installationLinked = true;
const savedPullRequests: Array<Record<string, unknown>> = [];

vi.mock("../db/store.js", () => ({
  getSession: async () => relation,
  savePullRequest: async (input: Record<string, unknown>) => {
    savedPullRequests.push(input);
    return input;
  },
  saveCheckpoint: async () => undefined,
  updateSessionHead: async () => undefined,
}));

vi.mock("../db/github-store.js", () => ({
  getGithubInstallationForUser: async () => (installationLinked ? { id: "installation-1", installationId: 55 } : undefined),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "installation-1", installationId: 55, status: "active" }],
        }),
      }),
    }),
  },
}));

const checkpoint = vi.fn(async () => ({
  checkpointCommit: "b".repeat(40),
  internalRef: "refs/cloud-agents/chats/session-1",
  createdCommit: true,
  changedFiles: [{ status: "A", path: "src/new.ts" }],
}));

vi.mock("./workspace-manager.js", async () => {
  const actual = await vi.importActual<typeof import("./workspace-manager.js")>("./workspace-manager.js");
  return { ...actual, workspaceManager: { checkpoint } };
});

const runChecked = vi.fn(async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  durationMs: 1,
}));
vi.mock("./process.js", () => ({ runChecked, runProcess: runChecked }));

const logged: unknown[] = [];
vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  const record = (...input: unknown[]) => logged.push(input);
  const child = () => ({ info: record, warn: record, error: record, debug: record, child });
  return { ...actual, logger: child() };
});

const { createPullRequestForChat } = await import("./pull-request.js");

const created = {
  number: 42,
  url: "https://github.com/acme/service/pull/42",
  state: "open",
  draft: false,
  title: "Add caching",
  headBranch: "agent/session-1",
  baseBranch: "main",
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    createInstallationToken: vi.fn(async () => ({ token, expiresAt: "" })),
    findPullRequest: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => created),
    ...overrides,
  } as never;
}

const writer = {
  emit: vi.fn<(type: string, payload?: Record<string, unknown>) => Promise<void>>(async () => undefined),
  live: vi.fn(),
  drain: vi.fn(async () => undefined),
};

function request(clientOverride: unknown) {
  return createPullRequestForChat({
    sessionId: session.id,
    runId: "run-1",
    repositoryPath: "/tmp/cloud-agents-tests/repository",
    title: "Add caching",
    body: "Adds a cache",
    writer: writer as never,
    client: clientOverride as never,
  });
}

beforeEach(() => {
  relation = { session: { ...session }, repository: { ...repository } };
  installationLinked = true;
  savedPullRequests.length = 0;
  logged.length = 0;
  runChecked.mockClear();
  writer.emit.mockClear();
  checkpoint.mockClear();
});

describe("create_pull_request", () => {
  it("checkpoints, pushes the exact commit, and opens the pull request", async () => {
    const github = client();
    const outcome = await request(github);

    expect(outcome).toMatchObject({ number: 42, url: created.url, state: "open", draft: false, reused: false });
    expect(outcome.headBranch).toBe("agent/session-1");
    expect(outcome.baseBranch).toBe("main");
    expect(checkpoint).toHaveBeenCalledTimes(1);

    const push = runChecked.mock.calls.find(([, args]: any) => args.includes("push")) as any;
    expect(push[0]).toBe("git");
    expect(push[1]).toContain(`${"b".repeat(40)}:refs/heads/agent/session-1`);
    expect(push[1]).toContain("https://github.com/acme/service.git");

    expect((github as any).createInstallationToken.mock.calls[0][0]).toMatchObject({
      installationId: 55,
      githubRepositoryIds: [900],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });

    const events = writer.emit.mock.calls.map(([type]) => type);
    expect(events).toContain("branch_published");
    expect(events).toContain("pull_request_created");
    expect(savedPullRequests[0]).toMatchObject({ number: 42, headCommit: "b".repeat(40), sessionId: "session-1" });
  });

  it("reuses the existing pull request when called again", async () => {
    const github = client({ findPullRequest: vi.fn(async () => created) });
    const outcome = await request(github);

    expect(outcome.reused).toBe(true);
    expect(outcome.number).toBe(42);
    expect((github as any).createPullRequest).not.toHaveBeenCalled();
  });

  it("recovers the existing pull request when GitHub rejects a duplicate", async () => {
    const findPullRequest = vi
      .fn<() => Promise<typeof created | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(created);
    const github = client({
      findPullRequest,
      createPullRequest: vi.fn(async () => {
        throw Object.assign(new Error("A pull request already exists"), { status: 422 });
      }),
    });

    const outcome = await request(github);
    expect(outcome.reused).toBe(true);
    expect(outcome.number).toBe(42);
  });

  it("never lets the model choose the repository or head branch", async () => {
    const github = client();
    await request(github);
    const [[call]] = (github as any).createPullRequest.mock.calls;
    expect(call).toMatchObject({
      owner: "acme",
      repository: "service",
      headBranch: "agent/session-1",
      baseBranch: "main",
    });
  });

  it("never stores or logs the installation token", async () => {
    const github = client();
    await request(github);

    expect(JSON.stringify(savedPullRequests)).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(JSON.stringify(writer.emit.mock.calls)).not.toContain(token);
    for (const [, args, options] of runChecked.mock.calls as any) {
      expect(JSON.stringify(args)).not.toContain(token);
      expect(args).not.toContain("credential.helper=store");
      const environment: Record<string, string> = options?.env ?? {};
      const carrying = Object.entries(environment).filter(([, value]) => value === token).map(([key]) => key);
      expect(carrying.length === 0 || carrying).toEqual(carrying.length === 0 ? true : ["GIT_CREDENTIAL_TOKEN"]);
    }
  });

  it("refuses a repository the user is not authorised for", async () => {
    installationLinked = false;
    await expect(request(client())).rejects.toThrow("You do not have access to this GitHub App installation");
  });

  it("refuses a repository that was removed from the installation", async () => {
    relation = { session: { ...session }, repository: { ...repository, githubAccess: "revoked" } };
    await expect(request(client())).rejects.toThrow("removed from the GitHub App installation");
  });

  it("refuses a repository that is not connected to the GitHub App", async () => {
    relation = { session: { ...session }, repository: { ...repository, githubInstallationId: null as never } };
    await expect(request(client())).rejects.toThrow("not connected to the Aitar GitHub App");
  });

  it("refuses to publish when the chat has produced no commit", async () => {
    checkpoint.mockResolvedValueOnce({
      checkpointCommit: session.baseCommit,
      internalRef: "refs/cloud-agents/chats/session-1",
      createdCommit: false,
      changedFiles: [],
    });
    await expect(request(client())).rejects.toThrow("nothing to publish");
  });
});
