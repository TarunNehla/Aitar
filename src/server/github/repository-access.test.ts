import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAppClient, type GitHubRequestInput } from "./app.js";
import { githubInstallationUsers, githubInstallations, repositories } from "../db/schema.js";
import type { RepositoryRow } from "../db/store.js";

const installationToken = "ghs_repositoryaccesstesttoken00000000";

let installationRow = {
  id: "installation-uuid",
  installationId: 4242,
  accountId: 99,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  status: "active",
};

let membershipGranted = true;

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (installationRow ? [installationRow] : []) }),
      }),
    }),
  },
  sql: {},
}));

vi.mock("../db/github-store.js", () => ({
  getGithubInstallationForUser: async () => (membershipGranted ? installationRow : undefined),
}));

const { withRepositoryGitAccess, readOnlyContentsPermissions } = await import("./repository-access.js");

const privateRepository: RepositoryRow = {
  id: "repository-uuid",
  ownerUserId: "user-owner",
  name: "service",
  repositoryUrl: "https://github.com/acme/service.git",
  defaultBranch: "main",
  githubRepositoryId: 7,
  githubInstallationId: "installation-uuid",
  githubFullName: "acme/service",
  githubOwnerLogin: "acme",
  githubPrivate: true,
  githubCloneUrl: "https://github.com/acme/service.git",
  githubAccess: "granted",
  lastFetchedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const publicRepository: RepositoryRow = {
  ...privateRepository,
  id: "public-repository-uuid",
  githubRepositoryId: null,
  githubInstallationId: null,
  githubPrivate: false,
};

function tokenClient() {
  const calls: GitHubRequestInput[] = [];
  const client = new GitHubAppClient(async (input) => {
    calls.push(input);
    return { token: installationToken, expires_at: "2026-08-06T23:00:00Z" };
  });
  return { client, calls };
}

beforeEach(() => {
  membershipGranted = true;
  installationRow = { ...installationRow, status: "active" };
});

describe("repository Git access", () => {
  it("mints a repository-scoped read-only token for private repositories", async () => {
    const { client, calls } = tokenClient();

    const seen = await withRepositoryGitAccess(
      { repository: privateRepository, userId: "user-owner", client },
      async (gitEnvironment) => ({ ...gitEnvironment }),
    );

    expect(calls[0].parameters).toMatchObject({
      installation_id: 4242,
      repository_ids: [7],
      permissions: readOnlyContentsPermissions,
    });
    expect(seen.GIT_CREDENTIAL_TOKEN).toBe(installationToken);
    expect(seen.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not mint a token for repositories without an installation", async () => {
    const { client, calls } = tokenClient();

    const seen = await withRepositoryGitAccess(
      { repository: publicRepository, userId: "user-owner", client },
      async (gitEnvironment) => ({ ...gitEnvironment }),
    );

    expect(calls).toHaveLength(0);
    expect(seen.GIT_CREDENTIAL_TOKEN).toBe("");
    expect(seen.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("refuses to mint a token for a user without the installation", async () => {
    membershipGranted = false;
    const { client, calls } = tokenClient();

    await expect(
      withRepositoryGitAccess(
        { repository: privateRepository, userId: "user-intruder", client },
        async () => undefined,
      ),
    ).rejects.toThrow("do not have access");
    expect(calls).toHaveLength(0);
  });

  it("refuses to mint a token for a suspended installation", async () => {
    installationRow = { ...installationRow, status: "suspended" };
    const { client, calls } = tokenClient();

    await expect(
      withRepositoryGitAccess({ repository: privateRepository, userId: "user-owner", client }, async () => undefined),
    ).rejects.toThrow("suspended");
    expect(calls).toHaveLength(0);
  });

  it("refuses to mint a token for a repository removed from the installation", async () => {
    const { client, calls } = tokenClient();

    await expect(
      withRepositoryGitAccess(
        { repository: { ...privateRepository, githubAccess: "revoked" }, userId: "user-owner", client },
        async () => undefined,
      ),
    ).rejects.toThrow("removed from the GitHub App installation");
    expect(calls).toHaveLength(0);
  });

  it("clears the token once the Git operation finishes", async () => {
    const { client } = tokenClient();
    let captured: NodeJS.ProcessEnv | null = null;

    await withRepositoryGitAccess(
      { repository: privateRepository, userId: "user-owner", client },
      async (gitEnvironment) => {
        captured = gitEnvironment;
      },
    );

    expect(captured!.GIT_CREDENTIAL_TOKEN).toBe("");
  });
});

describe("installation token storage", () => {
  it("has no database column that could hold a GitHub token", () => {
    const columnNames = [
      ...Object.keys(getTableColumns(githubInstallations)),
      ...Object.keys(getTableColumns(githubInstallationUsers)),
      ...Object.keys(getTableColumns(repositories)),
    ];

    for (const name of columnNames) {
      expect(name).not.toMatch(/token|secret|password|private_?key/i);
    }
  });

  it("keeps the minted token out of the repository record", async () => {
    const { client } = tokenClient();

    await withRepositoryGitAccess({ repository: privateRepository, userId: "user-owner", client }, async () => {
      expect(JSON.stringify(privateRepository)).not.toContain(installationToken);
    });

    expect(JSON.stringify(privateRepository)).not.toContain(installationToken);
    expect(JSON.stringify(installationRow)).not.toContain(installationToken);
  });
});
