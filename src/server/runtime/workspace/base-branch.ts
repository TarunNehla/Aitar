import { getSession, updateSessionBaseBranch } from "../../db/store.js";
import { withRepositoryGitAccess } from "../../github/repository-access.js";
import { logger } from "../../logger.js";
import { chatLocation, validateBranchName, workspaceManager } from "./workspace-manager.js";

const baseBranchLogger = logger.child({ component: "base-branch" });

export const chatHasChangesMessage =
  "This chat already contains changes. Start a new chat to use another base branch.";

export interface BaseBranchSwitch {
  baseBranch: string;
  baseCommit: string;
  changed: boolean;
}

/**
 * Moves a chat that has not produced anything yet onto another base branch of
 * the same repository. Existing work is never rebased, transferred, or dropped:
 * a chat that already carries changes is refused instead.
 */
export async function switchChatBaseBranch(input: {
  sessionId: string;
  branch: string;
}): Promise<BaseBranchSwitch> {
  const relation = await getSession(input.sessionId);
  if (!relation) throw new Error("This chat no longer exists");

  const { session, repository } = relation;
  const branch = validateBranchName(input.branch.trim());
  const checkpointed = Boolean(session.baseCommit && session.headCommit && session.headCommit !== session.baseCommit);
  if (checkpointed || (await workspaceManager.hasTrackedChanges(chatLocation(session.id).repository))) {
    throw new Error(chatHasChangesMessage);
  }

  return withRepositoryGitAccess({ repository }, async (gitEnvironment) => {
    const baseCommit = await workspaceManager.resolveBaseBranch({
      repositoryId: repository.id,
      repositoryUrl: repository.repositoryUrl,
      branch,
      gitEnvironment,
    });

    const settled =
      session.baseBranch === branch &&
      session.baseCommit === baseCommit &&
      session.headCommit === baseCommit &&
      (await workspaceManager.checkoutExists(session.id));
    if (settled) return { baseBranch: branch, baseCommit, changed: false };

    await workspaceManager.ensureChatCheckout({
      chatId: session.id,
      repositoryId: repository.id,
      repositoryUrl: repository.repositoryUrl,
      baseBranch: branch,
      baseCommit,
      headCommit: null,
      gitEnvironment,
    });
    await updateSessionBaseBranch({
      sessionId: session.id,
      baseBranch: branch,
      baseCommit,
      headCommit: baseCommit,
    });

    baseBranchLogger.info(
      { chatId: session.id, repositoryId: repository.id, baseBranch: branch },
      "Chat base branch switched",
    );
    return { baseBranch: branch, baseCommit, changed: true };
  });
}
