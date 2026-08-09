import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config, githubAppConfigured } from "../config.js";

export class GitHubAppNotConfiguredError extends Error {
  constructor() {
    super("The GitHub App is not configured on this server");
    this.name = "GitHubAppNotConfiguredError";
  }
}

export class GitHubInstallationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubInstallationUnavailableError";
  }
}

export interface GitHubRequestInput {
  route: string;
  parameters?: Record<string, unknown>;
  installationToken?: string;
}

export type GitHubRequest = (input: GitHubRequestInput) => Promise<unknown>;

export interface GitHubInstallationMetadata {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
}

export interface GitHubRepositorySummary {
  githubRepositoryId: number;
  name: string;
  fullName: string;
  ownerLogin: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
  headBranch: string;
  baseBranch: string;
}

let appClient: Octokit | null = null;

function applicationOctokit(): Octokit {
  if (!githubAppConfigured) throw new GitHubAppNotConfiguredError();
  appClient ??= new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID as string,
      privateKey: config.GITHUB_APP_PRIVATE_KEY as string,
    },
  });
  return appClient;
}

const octokitRequest: GitHubRequest = async ({ route, parameters, installationToken }) => {
  const client = installationToken ? new Octokit({ auth: installationToken }) : applicationOctokit();
  const response = await client.request(route, parameters ?? {});
  return response.data;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("GitHub returned an unexpected response");
  return value as Record<string, unknown>;
}

function toInstallation(value: unknown): GitHubInstallationMetadata {
  const data = record(value);
  const account = record(data.account ?? {});
  return {
    installationId: Number(data.id),
    accountId: Number(account.id ?? 0),
    accountLogin: String(account.login ?? account.slug ?? "unknown"),
    accountType: String(account.type ?? "Organization"),
    repositorySelection: String(data.repository_selection ?? "selected"),
    suspended: Boolean(data.suspended_at),
  };
}

function toRepositorySummary(value: unknown): GitHubRepositorySummary {
  const data = record(value);
  const owner = record(data.owner ?? {});
  return {
    githubRepositoryId: Number(data.id),
    name: String(data.name ?? ""),
    fullName: String(data.full_name ?? ""),
    ownerLogin: String(owner.login ?? ""),
    private: Boolean(data.private),
    defaultBranch: String(data.default_branch ?? "main"),
    cloneUrl: String(data.clone_url ?? ""),
  };
}

function toPullRequest(value: unknown): GitHubPullRequest {
  const data = record(value);
  const head = record(data.head ?? {});
  const base = record(data.base ?? {});
  return {
    number: Number(data.number),
    url: String(data.html_url ?? ""),
    state: String(data.state ?? "open"),
    draft: Boolean(data.draft),
    title: String(data.title ?? ""),
    headBranch: String(head.ref ?? ""),
    baseBranch: String(base.ref ?? ""),
  };
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export class GitHubAppClient {
  constructor(private readonly request: GitHubRequest = octokitRequest) {}

  async getInstallation(installationId: number): Promise<GitHubInstallationMetadata> {
    try {
      const data = await this.request({
        route: "GET /app/installations/{installation_id}",
        parameters: { installation_id: installationId },
      });
      return toInstallation(data);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) {
        throw new GitHubInstallationUnavailableError("That GitHub App installation is no longer available");
      }
      throw error;
    }
  }

  async createInstallationToken(input: {
    installationId: number;
    githubRepositoryIds?: number[];
    permissions?: Record<string, string>;
  }): Promise<InstallationToken> {
    try {
      const data = record(
        await this.request({
          route: "POST /app/installations/{installation_id}/access_tokens",
          parameters: {
            installation_id: input.installationId,
            ...(input.githubRepositoryIds?.length ? { repository_ids: input.githubRepositoryIds } : {}),
            ...(input.permissions ? { permissions: input.permissions } : {}),
          },
        }),
      );
      const token = data.token;
      if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
      return { token, expiresAt: String(data.expires_at ?? "") };
    } catch (error) {
      const status = statusOf(error);
      if (status === 403 || status === 404 || status === 410) {
        throw new GitHubInstallationUnavailableError(
          "That GitHub App installation can no longer access the repository",
        );
      }
      throw error;
    }
  }

  async findPullRequest(input: {
    installationToken: string;
    owner: string;
    repository: string;
    headBranch: string;
  }): Promise<GitHubPullRequest | null> {
    const data = await this.request({
      route: "GET /repos/{owner}/{repo}/pulls",
      parameters: {
        owner: input.owner,
        repo: input.repository,
        head: `${input.owner}:${input.headBranch}`,
        state: "open",
        per_page: 1,
      },
      installationToken: input.installationToken,
    });
    const pullRequests = Array.isArray(data) ? data : [];
    return pullRequests.length > 0 ? toPullRequest(pullRequests[0]) : null;
  }

  async createPullRequest(input: {
    installationToken: string;
    owner: string;
    repository: string;
    title: string;
    body?: string;
    headBranch: string;
    baseBranch: string;
    draft?: boolean;
  }): Promise<GitHubPullRequest> {
    const data = await this.request({
      route: "POST /repos/{owner}/{repo}/pulls",
      parameters: {
        owner: input.owner,
        repo: input.repository,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        head: input.headBranch,
        base: input.baseBranch,
        draft: Boolean(input.draft),
      },
      installationToken: input.installationToken,
    });
    return toPullRequest(data);
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubRepositorySummary[]> {
    const { token } = await this.createInstallationToken({
      installationId,
      permissions: { metadata: "read" },
    });
    const repositories: GitHubRepositorySummary[] = [];
    const maximumPages = 10;

    for (let page = 1; page <= maximumPages; page += 1) {
      const data = record(
        await this.request({
          route: "GET /installation/repositories",
          parameters: { per_page: 100, page },
          installationToken: token,
        }),
      );
      const pageRepositories = Array.isArray(data.repositories) ? data.repositories : [];
      repositories.push(...pageRepositories.map(toRepositorySummary));
      if (pageRepositories.length < 100) break;
    }

    return repositories;
  }
}

export const githubApp = new GitHubAppClient();

export function installationPageUrl(state: string): string {
  if (!githubAppConfigured) throw new GitHubAppNotConfiguredError();
  const url = new URL(`https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}
