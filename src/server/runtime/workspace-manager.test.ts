import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runChecked } from "./process.js";
import { safeWorkspacePath, validateRepositoryUrl, workspaceManager } from "./workspace-manager.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace path safety", () => {
  it("keeps file paths inside the repository", () => {
    expect(safeWorkspacePath("/tmp/repository", "src/index.ts")).toBe("/tmp/repository/src/index.ts");
    expect(() => safeWorkspacePath("/tmp/repository", "../secret")).toThrow("escapes");
  });

  it("only accepts public GitHub-style URLs", () => {
    expect(validateRepositoryUrl("https://github.com/openai/openai-node").hostname).toBe("github.com");
    expect(() => validateRepositoryUrl("https://example.com/project/repository")).toThrow("GitHub");
    expect(() => validateRepositoryUrl("https://token@github.com/owner/repository")).toThrow("credentials");
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

    await writeFile(join(repository, "new-file.txt"), "checkpointed\n");
    const checkpoint = await workspaceManager.checkpoint({
      workspaceId: "test-workspace",
      repositoryPath: repository,
      runId: "test-run",
      baseCommit,
    });

    expect(checkpoint.checkpointCommit).not.toBe(baseCommit);
    expect(checkpoint.changedFiles).toContainEqual({ status: "A", path: "new-file.txt" });

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
