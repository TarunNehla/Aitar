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
  it("captures new files in an internal commit and patch", async () => {
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
    expect(checkpoint.patchSize).toBeGreaterThan(0);
  });
});
