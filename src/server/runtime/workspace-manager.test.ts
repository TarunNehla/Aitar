import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runChecked } from "./process.js";
import {
  chatInternalRef,
  chatLocation,
  repositoryMirrorPath,
  validateBranchName,
  validateRepositoryUrl,
  workspaceManager,
} from "./workspace-manager.js";

const temporaryPaths: string[] = [];
const repositoryUrl = "https://github.com/acme/service";

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runChecked("git", args, { cwd })).stdout.trim();
}

/** Builds the protected mirror a chat checks out from, without touching the network. */
async function seedMirror(repositoryId: string) {
  const origin = await mkdtemp(join(tmpdir(), "cloud-agent-origin-"));
  const mirror = repositoryMirrorPath(repositoryId);
  temporaryPaths.push(origin, mirror);

  await runChecked("git", ["init", "-b", "main", origin]);
  await git(origin, "config", "user.name", "Test");
  await git(origin, "config", "user.email", "test@example.com");
  await writeFile(join(origin, "README.md"), "start\n");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", "initial");
  const mainCommit = await git(origin, "rev-parse", "HEAD");

  await git(origin, "checkout", "-b", "release");
  await writeFile(join(origin, "RELEASE.md"), "release\n");
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", "release");
  const releaseCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "checkout", "main");

  await mkdir(join(mirror, ".."), { recursive: true });
  await runChecked("git", ["init", "--bare", mirror]);
  await git(mirror, "fetch", origin, "+refs/heads/*:refs/remotes/origin/*");

  return { origin, mirror, mainCommit, releaseCommit };
}

async function checkoutChat(chatId: string, repositoryId: string, baseCommit: string) {
  temporaryPaths.push(chatLocation(chatId).root);
  return workspaceManager.ensureChatCheckout({
    chatId,
    repositoryId,
    repositoryUrl,
    baseBranch: "main",
    baseCommit,
    headCommit: null,
  });
}

describe("workspace path safety", () => {
  it("rejects branch names that could reach other refs", () => {
    expect(validateBranchName("agent/session-1")).toBe("agent/session-1");
    expect(() => validateBranchName("agent/../main")).toThrow("Invalid Git branch name");
    expect(() => validateBranchName("--upload-pack=touch")).toThrow("Invalid Git branch name");
  });

  it("only accepts public GitHub-style URLs", () => {
    expect(validateRepositoryUrl("https://github.com/openai/openai-node").hostname).toBe("github.com");
    expect(() => validateRepositoryUrl("https://example.com/project/repository")).toThrow("GitHub");
    expect(() => validateRepositoryUrl("https://token@github.com/owner/repository")).toThrow("credentials");
  });
});

describe("chat checkouts", () => {
  it("checks out the exact base commit with no local branch", async () => {
    const repositoryId = "detached-repository";
    const { mainCommit } = await seedMirror(repositoryId);

    const checkout = await checkoutChat("detached-chat", repositoryId, mainCommit);

    expect(checkout.created).toBe(true);
    expect(checkout.baseCommit).toBe(mainCommit);
    expect(checkout.headCommit).toBe(mainCommit);
    expect(await git(checkout.repository, "rev-parse", "HEAD")).toBe(mainCommit);
    expect(await git(checkout.repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(checkout.repository, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    await expect(runChecked("git", ["symbolic-ref", "HEAD"], { cwd: checkout.repository })).rejects.toThrow();
  });

  it("names no branch after the chat, locally or in the mirror", async () => {
    const repositoryId = "no-branch-repository";
    const chatId = "3f2c9a10-77b5-4e02-9d31-0b7c5a2e4d18";
    const { mainCommit, mirror } = await seedMirror(repositoryId);

    const checkout = await checkoutChat(chatId, repositoryId, mainCommit);

    const localRefs = await git(checkout.repository, "for-each-ref", "--format=%(refname)");
    const mirrorRefs = await git(mirror, "for-each-ref", "--format=%(refname)");
    expect(localRefs).not.toContain(chatId);
    expect(mirrorRefs).not.toContain(`refs/heads/agent/${chatId}`);
    expect(mirrorRefs).toContain(chatInternalRef(chatId));
  });

  it("lets the agent read, run commands, and edit while HEAD is detached", async () => {
    const repositoryId = "editing-repository";
    const { mainCommit } = await seedMirror(repositoryId);
    const checkout = await checkoutChat("editing-chat", repositoryId, mainCommit);

    expect(await readFile(join(checkout.repository, "README.md"), "utf8")).toBe("start\n");
    const listed = await runChecked(
      "node",
      ["-e", "process.stdout.write(require('node:fs').readdirSync('.').sort().join(','))"],
      { cwd: checkout.repository },
    );
    expect(listed.stdout).toContain("README.md");
    expect(await workspaceManager.hasTrackedChanges(checkout.repository)).toBe(false);

    await writeFile(join(checkout.repository, "README.md"), "edited\n");
    expect(await workspaceManager.hasTrackedChanges(checkout.repository)).toBe(true);

    const checkpoint = await workspaceManager.checkpoint({
      chatId: "editing-chat",
      repositoryId,
      repositoryPath: checkout.repository,
      runId: "run-1",
      baseCommit: mainCommit,
    });

    expect(checkpoint.createdCommit).toBe(true);
    expect(await workspaceManager.hasTrackedChanges(checkout.repository)).toBe(false);
    expect(await git(checkout.repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });

  it("keeps the checkpoint on a detached HEAD and in the internal reference", async () => {
    const repositoryId = "checkpoint-ref-repository";
    const chatId = "checkpoint-ref-chat";
    const { mainCommit, mirror } = await seedMirror(repositoryId);
    const checkout = await checkoutChat(chatId, repositoryId, mainCommit);

    await writeFile(join(checkout.repository, "feature.txt"), "work\n");
    const checkpoint = await workspaceManager.checkpoint({
      chatId,
      repositoryId,
      repositoryPath: checkout.repository,
      runId: "run-1",
      baseCommit: mainCommit,
    });

    expect(checkpoint.checkpointCommit).not.toBe(mainCommit);
    expect(checkpoint.internalRef).toBe(chatInternalRef(chatId));
    expect(await git(checkout.repository, "rev-parse", "HEAD")).toBe(checkpoint.checkpointCommit);
    expect(await git(checkout.repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(checkout.repository, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    expect(await git(checkout.repository, "rev-parse", `${checkpoint.checkpointCommit}^`)).toBe(mainCommit);
    expect(await git(mirror, "rev-parse", `${checkpoint.internalRef}^{commit}`)).toBe(checkpoint.checkpointCommit);
  });

  it("commits nothing a second time when the checkout is already clean", async () => {
    const repositoryId = "single-commit-repository";
    const chatId = "single-commit-chat";
    const { mainCommit } = await seedMirror(repositoryId);
    const checkout = await checkoutChat(chatId, repositoryId, mainCommit);

    await writeFile(join(checkout.repository, "feature.txt"), "work\n");
    const first = await workspaceManager.checkpoint({
      chatId, repositoryId, repositoryPath: checkout.repository, runId: "run-1", baseCommit: mainCommit,
    });
    const second = await workspaceManager.checkpoint({
      chatId, repositoryId, repositoryPath: checkout.repository, runId: "run-2", baseCommit: first.checkpointCommit,
    });

    expect(second.createdCommit).toBe(false);
    expect(second.checkpointCommit).toBe(first.checkpointCommit);
    expect((await git(checkout.repository, "rev-list", `${mainCommit}..HEAD`)).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("restores an evicted chat at its checkpoint, still detached", async () => {
    const repositoryId = "restore-repository";
    const chatId = "restore-chat";
    const { mainCommit } = await seedMirror(repositoryId);
    const checkout = await checkoutChat(chatId, repositoryId, mainCommit);

    await writeFile(join(checkout.repository, "feature.txt"), "work\n");
    const checkpoint = await workspaceManager.checkpoint({
      chatId, repositoryId, repositoryPath: checkout.repository, runId: "run-1", baseCommit: mainCommit,
    });
    await rm(chatLocation(chatId).root, { recursive: true, force: true });

    const restored = await workspaceManager.ensureChatCheckout({
      chatId,
      repositoryId,
      repositoryUrl,
      baseBranch: "main",
      baseCommit: mainCommit,
      headCommit: checkpoint.checkpointCommit,
    });

    expect(restored.created).toBe(true);
    expect(restored.headCommit).toBe(checkpoint.checkpointCommit);
    expect(await git(restored.repository, "rev-parse", "HEAD")).toBe(checkpoint.checkpointCommit);
    expect(await git(restored.repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(restored.repository, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    expect(await readFile(join(restored.repository, "feature.txt"), "utf8")).toBe("work\n");
  });

  it("reuses a checkout that is already on disk", async () => {
    const repositoryId = "reuse-repository";
    const { mainCommit } = await seedMirror(repositoryId);
    await checkoutChat("reuse-chat", repositoryId, mainCommit);

    const again = await workspaceManager.ensureChatCheckout({
      chatId: "reuse-chat",
      repositoryId,
      repositoryUrl,
      baseBranch: "main",
      baseCommit: mainCommit,
      headCommit: mainCommit,
    });

    expect(again.created).toBe(false);
  });

  it("refuses to restore a checkpoint the mirror never received", async () => {
    const repositoryId = "missing-checkpoint-repository";
    const { mainCommit } = await seedMirror(repositoryId);
    temporaryPaths.push(chatLocation("missing-checkpoint-chat").root);

    await expect(
      workspaceManager.ensureChatCheckout({
        chatId: "missing-checkpoint-chat",
        repositoryId,
        repositoryUrl,
        baseBranch: "main",
        baseCommit: mainCommit,
        headCommit: "c".repeat(40),
      }),
    ).rejects.toThrow("Chat checkpoint is missing from the repository mirror");
  });
});

describe("Git checkpoints", () => {
  it("captures new files in an internal commit and generates changes from Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-agent-checkpoint-"));
    temporaryPaths.push(root);
    temporaryPaths.push("/tmp/cloud-agents-tests/test-workspace");
    const repository = join(root, "repository");
    await mkdir(repository);
    await runChecked("git", ["init", "-b", "main"], { cwd: repository });
    await runChecked("git", ["config", "user.name", "Test"], { cwd: repository });
    await runChecked("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "start\n");
    await runChecked("git", ["add", "-A"], { cwd: repository });
    await runChecked("git", ["commit", "-m", "initial"], { cwd: repository });
    await runChecked("git", ["checkout", "-b", "cloud-agent/test-workspace"], { cwd: repository });
    const baseCommit = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const repositoryId = "checkpoint-repository";
    const mirror = repositoryMirrorPath(repositoryId);
    temporaryPaths.push(mirror);
    await mkdir(join(mirror, ".."), { recursive: true });
    await runChecked("git", ["init", "--bare", mirror]);

    await writeFile(join(repository, "new-file.txt"), "checkpointed\n");
    await mkdir(join(repository, "node_modules", "generated"), { recursive: true });
    await writeFile(join(repository, "node_modules", "generated", "index.js"), "ignored\n");
    const checkpoint = await workspaceManager.checkpoint({
      chatId: "test-workspace",
      repositoryId,
      repositoryPath: repository,
      runId: "test-run",
      baseCommit,
    });

    expect(checkpoint.checkpointCommit).not.toBe(baseCommit);
    expect(checkpoint.changedFiles).toContainEqual({ status: "A", path: "new-file.txt" });
    expect(checkpoint.changedFiles.map((file) => file.path)).not.toContain("node_modules/generated/index.js");

    const changes = await workspaceManager.codeChanges(repository, baseCommit, checkpoint.checkpointCommit);
    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]).toMatchObject({ status: "added", path: "new-file.txt", additions: 1, deletions: 0 });
    expect(changes.files[0]?.patch).toContain("+checkpointed");
  });

  it("reports modified, deleted, and renamed files with line counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-agent-diff-"));
    temporaryPaths.push(root);
    const repository = join(root, "repository");
    await mkdir(repository);
    await runChecked("git", ["init", "-b", "main"], { cwd: repository });
    await runChecked("git", ["config", "user.name", "Test"], { cwd: repository });
    await runChecked("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    await writeFile(join(repository, "modify.txt"), "before\n");
    await writeFile(join(repository, "delete.txt"), "remove me\n");
    await writeFile(join(repository, "rename.txt"), "keep me\n");
    await runChecked("git", ["add", "-A"], { cwd: repository });
    await runChecked("git", ["commit", "-m", "initial"], { cwd: repository });
    const baseCommit = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

    await writeFile(join(repository, "modify.txt"), "after\nextra\n");
    await runChecked("git", ["rm", "delete.txt"], { cwd: repository });
    await runChecked("git", ["mv", "rename.txt", "renamed.txt"], { cwd: repository });
    await runChecked("git", ["add", "-A"], { cwd: repository });
    await runChecked("git", ["commit", "-m", "changes"], { cwd: repository });
    const checkpointCommit = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

    const changes = await workspaceManager.codeChanges(repository, baseCommit, checkpointCommit);
    expect(changes.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "deleted", path: "delete.txt", deletions: 1 }),
      expect.objectContaining({ status: "modified", path: "modify.txt", additions: 2, deletions: 1 }),
      expect.objectContaining({ status: "renamed", previousPath: "rename.txt", path: "renamed.txt" }),
    ]));
  });
});
