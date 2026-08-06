import { describe, expect, it, vi } from "vitest";
import { GitHubAppClient, GitHubInstallationUnavailableError, type GitHubRequestInput } from "./app.js";
import { createInstallationState, verifyInstallationState } from "./installation-state.js";

const installationToken = "ghs_mintedinstallationtoken0000000000000";

function fakeGitHub(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: GitHubRequestInput[] = [];
  const request = vi.fn(async (input: GitHubRequestInput) => {
    calls.push(input);
    if (input.route === "POST /app/installations/{installation_id}/access_tokens") {
      return overrides.accessTokens ?? { token: installationToken, expires_at: "2026-08-06T23:00:00Z" };
    }
    if (input.route === "GET /app/installations/{installation_id}") {
      return (
        overrides.installation ?? {
          id: 4242,
          repository_selection: "selected",
          suspended_at: null,
          account: { id: 99, login: "acme", type: "Organization" },
        }
      );
    }
    if (input.route === "GET /installation/repositories") {
      return (
        overrides.repositories ?? {
          repositories: [
            {
              id: 7,
              name: "service",
              full_name: "acme/service",
              private: true,
              default_branch: "main",
              clone_url: "https://github.com/acme/service.git",
              owner: { login: "acme" },
            },
          ],
        }
      );
    }
    throw new Error(`Unexpected route ${input.route}`);
  });

  return { request, calls, client: new GitHubAppClient(request) };
}

describe("GitHub App installation tokens", () => {
  it("mints a token scoped to one repository with read-only contents", async () => {
    const { client, calls } = fakeGitHub();

    const token = await client.createInstallationToken({
      installationId: 4242,
      githubRepositoryIds: [7],
      permissions: { contents: "read", metadata: "read" },
    });

    expect(token.token).toBe(installationToken);
    expect(calls[0]).toMatchObject({
      route: "POST /app/installations/{installation_id}/access_tokens",
      parameters: {
        installation_id: 4242,
        repository_ids: [7],
        permissions: { contents: "read", metadata: "read" },
      },
    });
  });

  it("reads installation metadata without exposing tokens", async () => {
    const { client } = fakeGitHub();
    const installation = await client.getInstallation(4242);

    expect(installation).toEqual({
      installationId: 4242,
      accountId: 99,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
    });
    expect(JSON.stringify(installation)).not.toContain(installationToken);
  });

  it("lists installation repositories using a freshly minted token", async () => {
    const { client, calls } = fakeGitHub();
    const repositories = await client.listInstallationRepositories(4242);

    expect(repositories).toEqual([
      {
        githubRepositoryId: 7,
        name: "service",
        fullName: "acme/service",
        ownerLogin: "acme",
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/acme/service.git",
      },
    ]);
    expect(calls[0].route).toBe("POST /app/installations/{installation_id}/access_tokens");
    expect(calls[1].installationToken).toBe(installationToken);
    expect(JSON.stringify(repositories)).not.toContain(installationToken);
  });

  it("reports a removed installation as unavailable", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const client = new GitHubAppClient(request);

    await expect(client.getInstallation(4242)).rejects.toBeInstanceOf(GitHubInstallationUnavailableError);
  });

  it("reports a revoked repository as unavailable", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    });
    const client = new GitHubAppClient(request);

    await expect(
      client.createInstallationToken({ installationId: 4242, githubRepositoryIds: [7] }),
    ).rejects.toBeInstanceOf(GitHubInstallationUnavailableError);
  });
});

describe("GitHub installation state", () => {
  it("round-trips a signed state for one user", () => {
    const state = createInstallationState("user-1");
    expect(verifyInstallationState(state)).toEqual({ userId: "user-1" });
  });

  it("rejects a tampered state", () => {
    const state = createInstallationState("user-1");
    const [payload, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ userId: "user-2", nonce: "n", expiresAt: Date.now() + 1000 }))
      .toString("base64url");

    expect(verifyInstallationState(`${forged}.${signature}`)).toBeNull();
    expect(verifyInstallationState(`${payload}.${signature}x`)).toBeNull();
    expect(verifyInstallationState("not-a-state")).toBeNull();
  });

  it("expires a state after its short lifetime", () => {
    const issuedAt = Date.now();
    const state = createInstallationState("user-1", issuedAt);

    expect(verifyInstallationState(state, issuedAt + 60_000)).toEqual({ userId: "user-1" });
    expect(verifyInstallationState(state, issuedAt + 3_600_000)).toBeNull();
  });
});
