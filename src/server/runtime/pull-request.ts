import { getSession, savePullRequest, saveCheckpoint, updateSessionHead } from "../db/store.js";
import { githubApp, type GitHubAppClient, type GitHubPullRequest } from "../github/app.js";
import { withRepositoryPullRequestAccess } from "../github/repository-access.js";
import { logger } from "../logger.js";
import type { EventWriter } from "./event-writer.js";
import { runChecked } from "./process.js";
import { validateBranchName, workspaceManager } from "./workspace-manager.js";

const pullRequestLogger = logger.child({ component: "pull-request" });

export interface PullRequestOutcome {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  reused: boolean;
}

function ownerAndRepository(fullName: string): { owner: string; repository: string } {
  const [owner, repository] = fullName.split("/");
  if (!owner || !repository) throw new Error("This repository is missing its GitHub owner and name");
  return { owner, repository };
}

/**
 * The model chooses only the title, body, and draft flag. Everything that
 * decides *where* the change lands is derived from the chat on the backend.
 */
export async function createPullRequestForChat(input: {
  sessionId: string;
  runId: string;
  repositoryPath: string;
  title: string;
  body?: string;
  draft?: boolean;
  writer: EventWriter;
  client?: GitHubAppClient;
}): Promise<PullRequestOutcome> {
  const relation = await getSession(input.sessionId);
  if (!relation) throw new Error("This chat no longer exists");

  const { session, repository } = relation;
  if (!repository.ownerUserId) throw new Error("This repository has no owner");
  if (!session.baseCommit) throw new Error("This chat environment is not ready");

  const headBranch = validateBranchName(session.branchName);
  const baseBranch = validateBranchName(session.baseBranch);
  const { owner, repository: repositoryName } = ownerAndRepository(repository.githubFullName ?? "");

  const checkpoint = await workspaceManager.checkpoint({
    chatId: session.id,
    repositoryId: repository.id,
    repositoryPath: input.repositoryPath,
    runId: input.runId,
    baseCommit: session.headCommit ?? session.baseCommit,
  });
  if (checkpoint.createdCommit) {
    await saveCheckpoint({
      sessionId: session.id,
      runId: input.runId,
      baseCommit: session.headCommit ?? session.baseCommit,
      checkpointCommit: checkpoint.checkpointCommit,
      internalRef: checkpoint.internalRef,
    });
    await updateSessionHead(session.id, checkpoint.checkpointCommit);
    await input.writer.emit("checkpoint_saved", {
      commit: checkpoint.checkpointCommit,
      createdCommit: true,
      changedFileCount: checkpoint.changedFiles.length,
    });
  }

  const headCommit = checkpoint.checkpointCommit;
  if (headCommit === session.baseCommit) {
    throw new Error("There is nothing to publish yet. Make a change before opening a pull request.");
  }

  const client = input.client ?? githubApp;
  const pullRequest = await withRepositoryPullRequestAccess(
    { repository, userId: repository.ownerUserId, client },
    async ({ token, gitEnvironment }) => {
      await runChecked(
        "git",
        [
          "-c", "core.hooksPath=/var/empty",
          "-c", "credential.helper=",
          "push", "--force", "--",
          repository.repositoryUrl,
          `${headCommit}:refs/heads/${headBranch}`,
        ],
        { cwd: input.repositoryPath, env: gitEnvironment, timeoutMs: 180_000 },
      );
      await input.writer.emit("branch_published", { branch: headBranch, commit: headCommit });

      const existing = await client.findPullRequest({
        installationToken: token,
        owner,
        repository: repositoryName,
        headBranch,
      });
      if (existing) return { pullRequest: existing, reused: true };

      const created = await createOrRecoverPullRequest({
        client,
        token,
        owner,
        repository: repositoryName,
        title: input.title,
        body: input.body,
        headBranch,
        baseBranch,
        draft: input.draft,
      });
      return created;
    },
  );

  await savePullRequest({
    sessionId: session.id,
    repositoryId: repository.id,
    number: pullRequest.pullRequest.number,
    url: pullRequest.pullRequest.url,
    state: pullRequest.pullRequest.state,
    draft: pullRequest.pullRequest.draft,
    title: pullRequest.pullRequest.title,
    headBranch: pullRequest.pullRequest.headBranch || headBranch,
    baseBranch: pullRequest.pullRequest.baseBranch || baseBranch,
    headCommit,
  });

  const outcome: PullRequestOutcome = {
    number: pullRequest.pullRequest.number,
    url: pullRequest.pullRequest.url,
    state: pullRequest.pullRequest.state,
    draft: pullRequest.pullRequest.draft,
    title: pullRequest.pullRequest.title,
    headBranch: pullRequest.pullRequest.headBranch || headBranch,
    baseBranch: pullRequest.pullRequest.baseBranch || baseBranch,
    headCommit,
    reused: pullRequest.reused,
  };

  await input.writer.emit("pull_request_created", {
    number: outcome.number,
    url: outcome.url,
    state: outcome.state,
    draft: outcome.draft,
    title: outcome.title,
    headBranch: outcome.headBranch,
    baseBranch: outcome.baseBranch,
    reused: outcome.reused,
  });
  pullRequestLogger.info(
    { sessionId: session.id, repositoryId: repository.id, number: outcome.number, reused: outcome.reused },
    "Pull request published",
  );

  return outcome;
}

/** GitHub answers a duplicate branch with 422, so re-read instead of failing the tool. */
async function createOrRecoverPullRequest(input: {
  client: GitHubAppClient;
  token: string;
  owner: string;
  repository: string;
  title: string;
  body?: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
}): Promise<{ pullRequest: GitHubPullRequest; reused: boolean }> {
  try {
    const created = await input.client.createPullRequest({
      installationToken: input.token,
      owner: input.owner,
      repository: input.repository,
      title: input.title,
      body: input.body,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      draft: input.draft,
    });
    return { pullRequest: created, reused: false };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422) throw error;
    const existing = await input.client.findPullRequest({
      installationToken: input.token,
      owner: input.owner,
      repository: input.repository,
      headBranch: input.headBranch,
    });
    if (!existing) throw error;
    return { pullRequest: existing, reused: true };
  }
}
