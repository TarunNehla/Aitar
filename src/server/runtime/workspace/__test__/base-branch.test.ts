import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryUrl = "https://github.com/acme/service";
const chatId = "6c1f0f2c-0f8e-4a63-9f5a-5a17a6c0c111";

const repository = {
  id: "base-branch-repository",
  ownerUserId: "user-1",
  repositoryUrl,
  githubInstallationId: null,
  githubRepositoryId: null,
};

let session = {
  id: chatId,
  repositoryId: repository.id,
  baseBranch: "main",
  baseCommit: null as string | null,
  headCommit: null as string | null,
};

const savedBaseBranches: Array<Record<string, unknown>> = [];

vi.mock("../../../db/store.js", () => ({
  getSession: async () => ({ session, repository }),
  updateSessionBaseBranch: async (input: Record<string, unknown>) => {
    savedBaseBranches.push(input);
    session = {
      ...session,
      baseBranch: String(input.baseBranch),
      baseCommit: String(input.baseCommit),
      headCommit: String(input.headCommit),
    };
    return session;
  },
}));

vi.mock("../../../github/repository-access.js", () => ({
  withRepositoryGitAccess: async (_input: unknown, operation: (env: NodeJS.ProcessEnv) => Promise<unknown>) =>
    operation({}),
}));

const removeContainer = vi.fn(async () => undefined);
const closeBrowser = vi.fn(async () => true);
const stopAll = vi.fn(async () => undefined);
vi.mock("../../sandbox/sandbox.js", () => ({ sandbox: { removeContainer } }));
vi.mock("../../browser/browser-session.js", () => ({ browserSessions: { close: closeBrowser } }));
vi.mock("../../sandbox/sandbox-processes.js", () => ({ processManager: { stopAll } }));

const { runChecked } = await import("../../process.js");
const { switchChatBaseBranch, chatHasChangesMessage } = await import("../base-branch.js");
const { chatInternalRef, chatLocation, repositoryMirrorPath, workspaceManager } = await import("../workspace-manager.js");

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runChecked("git", args, { cwd })).stdout.trim();
}

let origin = "";
let mainCommit = "";
let releaseCommit = "";
let previousGitConfigGlobal: string | undefined;
const temporaryPaths: string[] = [];

beforeAll(async () => {
  origin = await mkdtemp(join(tmpdir(), "cloud-agent-base-origin-"));
  temporaryPaths.push(origin, repositoryMirrorPath(repository.id), chatLocation(chatId).root);

  await runChecked("git", ["init", "-b", "main", origin]);
  await git(origin, "config", "user.name", "Test");
  await git(origin, "config", "user.email", "test@example.com");
  await writeFile(join(origin, "README.md"), "start\n");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", "initial");
  mainCommit = await git(origin, "rev-parse", "HEAD");

  await git(origin, "checkout", "-b", "release");
  await writeFile(join(origin, "RELEASE.md"), "release\n");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", "release");
  releaseCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "checkout", "main");

  // The mirror fetch is a real one, pointed at this local origin instead of GitHub.
  const gitConfig = join(origin, "..", `cloud-agent-base-config-${process.pid}`);
  await writeFile(gitConfig, `[url "${origin}"]\n\tinsteadOf = ${repositoryUrl}\n`);
  temporaryPaths.push(gitConfig);
  previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
});

afterAll(async () => {
  if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })));
});

beforeEach(async () => {
  savedBaseBranches.length = 0;
  removeContainer.mockClear();
  closeBrowser.mockClear();
  stopAll.mockClear();
  await rm(chatLocation(chatId).root, { recursive: true, force: true });
  await rm(repositoryMirrorPath(repository.id), { recursive: true, force: true });
  session = { id: chatId, repositoryId: repository.id, baseBranch: "main", baseCommit: null, headCommit: null };
});

/** Puts the chat where a first run leaves it: a detached checkout at the base commit. */
async function openChat() {
  const checkout = await workspaceManager.ensureChatCheckout({
    chatId,
    repositoryId: repository.id,
    repositoryUrl,
    baseBranch: session.baseBranch,
  });
  session = { ...session, baseCommit: checkout.baseCommit, headCommit: checkout.headCommit };
  return checkout;
}

describe("switch_base_branch", () => {
  it("re-creates the checkout at the requested branch, detached", async () => {
    await openChat();

    const outcome = await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(outcome).toEqual({ baseBranch: "release", baseCommit: releaseCommit, changed: true });
    const repositoryPath = chatLocation(chatId).repository;
    expect(await git(repositoryPath, "rev-parse", "HEAD")).toBe(releaseCommit);
    expect(await git(repositoryPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(repositoryPath, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    expect(await git(repositoryMirrorPath(repository.id), "rev-parse", `${chatInternalRef(chatId)}^{commit}`))
      .toBe(releaseCommit);
  });

  it("keeps the stored base branch, base commit, and head commit in step", async () => {
    await openChat();
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(savedBaseBranches).toEqual([
      { sessionId: chatId, baseBranch: "release", baseCommit: releaseCommit, headCommit: releaseCommit },
    ]);
    expect(session).toMatchObject({ baseBranch: "release", baseCommit: releaseCommit, headCommit: releaseCommit });
  });

  it("works before the chat has ever been checked out", async () => {
    const outcome = await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(outcome.changed).toBe(true);
    expect(await git(chatLocation(chatId).repository, "rev-parse", "HEAD")).toBe(releaseCommit);
  });

  it("stops the chat's processes and browser before replacing the checkout", async () => {
    await openChat();
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(stopAll).toHaveBeenCalledWith(chatId);
    expect(closeBrowser).toHaveBeenCalledWith(chatId);
    expect(removeContainer).toHaveBeenCalledWith(chatId);
  });

  it("rejects a branch the repository does not have", async () => {
    await openChat();

    await expect(switchChatBaseBranch({ sessionId: chatId, branch: "nope" })).rejects.toThrow(
      "Branch nope is not in this repository",
    );
    expect(savedBaseBranches).toEqual([]);
    expect(session.baseBranch).toBe("main");
  });

  it("rejects a branch name that could reach another ref", async () => {
    await openChat();

    for (const branch of ["../main", "--upload-pack=touch", "release^{commit}", "with space"]) {
      await expect(switchChatBaseBranch({ sessionId: chatId, branch }), branch).rejects.toThrow(
        "Invalid Git branch name",
      );
    }
    expect(savedBaseBranches).toEqual([]);
  });

  it("refuses once the chat has uncommitted changes", async () => {
    const checkout = await openChat();
    await writeFile(join(checkout.repository, "README.md"), "edited\n");

    await expect(switchChatBaseBranch({ sessionId: chatId, branch: "release" })).rejects.toThrow(
      chatHasChangesMessage,
    );
    expect(await git(checkout.repository, "rev-parse", "HEAD")).toBe(mainCommit);
    expect(savedBaseBranches).toEqual([]);
  });

  it("refuses once the chat has a checkpoint, and keeps that work", async () => {
    const checkout = await openChat();
    await writeFile(join(checkout.repository, "feature.txt"), "work\n");
    const checkpoint = await workspaceManager.checkpoint({
      chatId,
      repositoryId: repository.id,
      repositoryPath: checkout.repository,
      runId: "run-1",
      baseCommit: mainCommit,
    });
    session = { ...session, headCommit: checkpoint.checkpointCommit };

    await expect(switchChatBaseBranch({ sessionId: chatId, branch: "release" })).rejects.toThrow(
      "Start a new chat to use another base branch",
    );
    expect(await git(checkout.repository, "rev-parse", "HEAD")).toBe(checkpoint.checkpointCommit);
    expect(savedBaseBranches).toEqual([]);
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it("is idempotent when the chat already starts from that branch", async () => {
    await openChat();
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });
    savedBaseBranches.length = 0;

    const again = await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(again).toEqual({ baseBranch: "release", baseCommit: releaseCommit, changed: false });
    expect(savedBaseBranches).toEqual([]);
    expect(await git(chatLocation(chatId).repository, "rev-parse", "HEAD")).toBe(releaseCommit);
  });

  it("moves back to the branch the chat started from", async () => {
    await openChat();
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    const outcome = await switchChatBaseBranch({ sessionId: chatId, branch: "main" });

    expect(outcome).toEqual({ baseBranch: "main", baseCommit: mainCommit, changed: true });
    expect(await git(chatLocation(chatId).repository, "rev-parse", "HEAD")).toBe(mainCommit);
  });

  it("never hands Git credentials to Docker", async () => {
    await openChat();
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    for (const call of removeContainer.mock.calls as unknown as unknown[][]) {
      expect(JSON.stringify(call)).not.toContain("GIT_CREDENTIAL");
    }
  });

  /** Keeps the suite honest: the mirror really is a fetch away, not a copied directory. */
  it("updates the repository mirror from the remote before resolving the branch", async () => {
    await mkdir(repositoryMirrorPath(repository.id), { recursive: true });
    await switchChatBaseBranch({ sessionId: chatId, branch: "release" });

    expect(await git(repositoryMirrorPath(repository.id), "rev-parse", "refs/remotes/origin/release^{commit}"))
      .toBe(releaseCommit);
  });
});

describe("the agent is told the rule", () => {
  it("sends the model to switch_base_branch instead of a bash checkout", async () => {
    const runner = await readFile(new URL("../../agent/agent-runner.ts", import.meta.url), "utf8");
    const prompt = runner.slice(runner.indexOf("const systemPrompt"), runner.indexOf("].join(\"\\n\")"));

    expect(prompt).toContain("switch_base_branch");
    expect(prompt).toMatch(/git checkout/);
    expect(prompt).toMatch(/detached HEAD/);
  });
});
