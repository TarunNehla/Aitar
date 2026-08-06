import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { getGithubInstallationForUser } from "../db/github-store.js";
import type { RepositoryRow } from "../db/store.js";
import { githubInstallations } from "../db/schema.js";
import { logger } from "../logger.js";
import { baseGitEnvironment, withInstallationCredentials } from "../runtime/git-credentials.js";
import { GitHubInstallationUnavailableError, githubApp, type GitHubAppClient } from "./app.js";

const accessLogger = logger.child({ component: "github-repository-access" });

export const readOnlyContentsPermissions = { contents: "read", metadata: "read" } as const;

async function installationForRepository(repository: RepositoryRow, userId: string) {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, repository.githubInstallationId as string))
    .limit(1);

  if (!installation) {
    throw new GitHubInstallationUnavailableError("This repository is no longer linked to a GitHub App installation");
  }
  if (installation.status === "suspended") {
    throw new GitHubInstallationUnavailableError("The GitHub App installation for this repository is suspended");
  }
  if (installation.status !== "active") {
    throw new GitHubInstallationUnavailableError("The GitHub App installation for this repository was removed");
  }
  if (repository.githubAccess !== "granted") {
    throw new GitHubInstallationUnavailableError("This repository was removed from the GitHub App installation");
  }

  const authorised = await getGithubInstallationForUser({
    installationId: installation.installationId,
    userId,
  });
  if (!authorised) {
    throw new GitHubInstallationUnavailableError("You do not have access to this GitHub App installation");
  }

  return installation;
}

export async function withRepositoryGitAccess<T>(
  input: { repository: RepositoryRow; userId?: string | null; client?: GitHubAppClient },
  operation: (gitEnvironment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const userId = input.userId ?? input.repository.ownerUserId;
  if (!input.repository.githubInstallationId || !userId) {
    return operation(baseGitEnvironment());
  }

  const installation = await installationForRepository(input.repository, userId);
  const client = input.client ?? githubApp;
  const { token } = await client.createInstallationToken({
    installationId: installation.installationId,
    githubRepositoryIds: input.repository.githubRepositoryId
      ? [input.repository.githubRepositoryId]
      : undefined,
    permissions: { ...readOnlyContentsPermissions },
  });

  accessLogger.info(
    { repositoryId: input.repository.id, installationId: installation.installationId },
    "GitHub installation token minted for a Git operation",
  );

  return withInstallationCredentials(token, operation);
}
