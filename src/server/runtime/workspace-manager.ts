import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CodeChanges, FileChangeStatus } from "../../shared/contracts.js";
import { config } from "../config.js";
import { errorForLog, logger } from "../logger.js";
import { runChecked, runProcess, type ProcessResult } from "./process.js";

const workspaceLogger = logger.child({ component: "workspace-manager" });

export interface WorkspaceLocation {
  root: string;
  repository: string;
}

export function workspaceLocation(workspaceId: string): WorkspaceLocation {
  const root = join(config.WORKSPACE_ROOT, workspaceId);
  return {
    root,
    repository: join(root, "repository"),
  };
}

export function validateRepositoryUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("V0 supports public HTTPS GitHub repositories only");
  }
  if (url.username || url.password) {
    throw new Error("Repository URLs must not contain credentials");
  }
  if (url.pathname.split("/").filter(Boolean).length !== 2) {
    throw new Error("Repository URL must contain an owner and repository name");
  }
  return url;
}

export function safeWorkspacePath(repositoryPath: string, requestedPath: string): string {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("Invalid path");
  const resolvedRepository = resolve(repositoryPath);
  const resolvedPath = resolve(resolvedRepository, requestedPath);
  if (resolvedPath !== resolvedRepository && !resolvedPath.startsWith(`${resolvedRepository}${sep}`)) {
    throw new Error("Path escapes the workspace");
  }
  return resolvedPath;
}

function containerName(workspaceId: string): string {
  return `cloud-agent-${workspaceId}`;
}

export class WorkspaceManager {
  async prepare(input: { workspaceId: string; repositoryUrl: string; baseBranch: string }) {
    const startedAt = Date.now();
    workspaceLogger.info({ workspaceId: input.workspaceId }, "Workspace preparation started");
    const url = validateRepositoryUrl(input.repositoryUrl);
    const location = workspaceLocation(input.workspaceId);
    await mkdir(location.root, { recursive: true });

    await runChecked("git", [
      "clone",
      "--branch",
      input.baseBranch,
      "--single-branch",
      "--",
      url.toString(),
      location.repository,
    ]);

    await runChecked("git", ["config", "user.name", "Cloud Agent"], { cwd: location.repository });
    await runChecked("git", ["config", "user.email", "cloud-agent@local"], { cwd: location.repository });
    await runChecked("git", ["checkout", "-b", `cloud-agent/${input.workspaceId}`], { cwd: location.repository });

    const baseCommit = (await runChecked("git", ["rev-parse", "HEAD"], { cwd: location.repository })).stdout.trim();
    await this.ensureSandbox(input.workspaceId, location.repository);
    workspaceLogger.info(
      { workspaceId: input.workspaceId, durationMs: Date.now() - startedAt },
      "Workspace preparation completed",
    );
    return { ...location, baseCommit };
  }

  async ensureSandbox(workspaceId: string, repositoryPath: string): Promise<string> {
    const name = containerName(workspaceId);
    const inspected = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 10_000 });
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") {
      workspaceLogger.debug({ workspaceId, containerName: name }, "Sandbox container reused");
      return name;
    }

    if (inspected.exitCode === 0) {
      workspaceLogger.info({ workspaceId, containerName: name }, "Sandbox container starting");
      await runChecked("docker", ["start", name], { timeoutMs: 30_000 });
      workspaceLogger.info({ workspaceId, containerName: name }, "Sandbox container started");
      return name;
    }

    workspaceLogger.info(
      {
        workspaceId,
        containerName: name,
        image: config.SANDBOX_IMAGE,
        memoryMb: config.SANDBOX_MEMORY_MB,
        cpus: config.SANDBOX_CPUS,
      },
      "Sandbox container creating",
    );
    await runChecked(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--workdir",
        "/workspace",
        "--mount",
        `type=bind,src=${repositoryPath},dst=/workspace`,
        "--memory",
        `${config.SANDBOX_MEMORY_MB}m`,
        "--cpus",
        String(config.SANDBOX_CPUS),
        "--pids-limit",
        "256",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        config.SANDBOX_IMAGE,
        "sleep",
        "infinity",
      ],
      { timeoutMs: 120_000 },
    );
    workspaceLogger.info({ workspaceId, containerName: name }, "Sandbox container created");
    return name;
  }

  async execute(
    workspaceId: string,
    repositoryPath: string,
    command: string,
    options: {
      signal?: AbortSignal;
      network?: boolean;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    } = {},
  ): Promise<ProcessResult> {
    const startedAt = Date.now();
    workspaceLogger.info(
      { workspaceId, network: Boolean(options.network), commandBytes: Buffer.byteLength(command) },
      "Sandbox command started",
    );
    const common = {
      signal: options.signal,
      timeoutMs: config.SANDBOX_TIMEOUT_SECONDS * 1_000,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    };

    try {
      let result: ProcessResult;
      if (options.network) {
        result = await runProcess(
          "docker",
          [
            "run",
            "--rm",
            "--workdir",
            "/workspace",
            "--mount",
            `type=bind,src=${repositoryPath},dst=/workspace`,
            "--memory",
            `${config.SANDBOX_MEMORY_MB}m`,
            "--cpus",
            String(config.SANDBOX_CPUS),
            "--pids-limit",
            "256",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            config.SANDBOX_IMAGE,
            "sh",
            "-lc",
            command,
          ],
          common,
        );
      } else {
        const name = await this.ensureSandbox(workspaceId, repositoryPath);
        result = await runProcess("docker", ["exec", name, "sh", "-lc", command], common);
      }

      const data = {
        workspaceId,
        network: Boolean(options.network),
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
      };
      if (result.exitCode === 0) workspaceLogger.info(data, "Sandbox command completed");
      else workspaceLogger.warn(data, "Sandbox command failed");
      return result;
    } catch (error) {
      workspaceLogger.error(
        { error: errorForLog(error), workspaceId, network: Boolean(options.network), durationMs: Date.now() - startedAt },
        "Sandbox command could not complete",
      );
      throw error;
    }
  }

  async listFiles(repositoryPath: string, limit = 500): Promise<string[]> {
    const result = await runChecked("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repositoryPath,
    });
    return result.stdout.split("\n").filter(Boolean).slice(0, limit);
  }

  async readFile(repositoryPath: string, requestedPath: string): Promise<string> {
    const path = safeWorkspacePath(repositoryPath, requestedPath);
    const file = await stat(path);
    if (file.size > 512 * 1024) throw new Error("File is larger than the V0 read limit");
    return readFile(path, "utf8");
  }

  async writeFile(repositoryPath: string, requestedPath: string, content: string): Promise<void> {
    const path = safeWorkspacePath(repositoryPath, requestedPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async searchFiles(repositoryPath: string, query: string, limit = 200): Promise<string> {
    const files = await this.listFiles(repositoryPath, 5_000);
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      let content: string;
      try {
        content = await this.readFile(repositoryPath, file);
      } catch {
        continue;
      }
      content.split("\n").forEach((line, index) => {
        if (matches.length < limit && line.toLowerCase().includes(query.toLowerCase())) {
          matches.push(`${file}:${index + 1}:${line}`);
        }
      });
    }
    return matches.join("\n");
  }

  async checkpoint(input: { workspaceId: string; repositoryPath: string; runId: string; baseCommit: string }) {
    await runChecked("git", ["add", "-A"], { cwd: input.repositoryPath });
    const staged = await runChecked("git", ["diff", "--cached", "--quiet"], { cwd: input.repositoryPath }).catch(() => null);
    const createdCommit = !staged;

    if (createdCommit) {
      await runChecked("git", ["commit", "--no-verify", "-m", `checkpoint: ${input.runId}`], {
        cwd: input.repositoryPath,
      });
    }

    const checkpointCommit = (
      await runChecked("git", ["rev-parse", "HEAD"], { cwd: input.repositoryPath })
    ).stdout.trim();
    const internalRef = `refs/heads/cloud-agent/${input.workspaceId}`;
    const changedFiles = await this.changedFiles(input.repositoryPath, input.baseCommit, checkpointCommit);

    workspaceLogger.info(
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        changedFileCount: changedFiles.length,
      },
      "Workspace checkpoint saved",
    );

    return {
      checkpointCommit,
      internalRef,
      createdCommit,
      changedFiles,
    };
  }

  async changedFiles(repositoryPath: string, baseCommit: string, checkpointCommit = "HEAD") {
    const result = await runChecked("git", ["diff", "--find-renames", "--name-status", "-z", `${baseCommit}..${checkpointCommit}`], {
      cwd: repositoryPath,
    });
    const parts = result.stdout.split("\0");
    const files: Array<{ status: string; path: string; previousPath?: string }> = [];
    let index = 0;
    while (index < parts.length && parts[index]) {
      const status = parts[index++] ?? "M";
      if (status.startsWith("R") || status.startsWith("C")) {
        const previousPath = parts[index++] ?? "";
        const path = parts[index++] ?? "";
        files.push({ status, path, previousPath });
      } else {
        files.push({ status, path: parts[index++] ?? "" });
      }
    }
    return files;
  }

  async codeChanges(repositoryPath: string, baseCommit: string, checkpointCommit: string): Promise<CodeChanges> {
    const changedFiles = await this.changedFiles(repositoryPath, baseCommit, checkpointCommit);
    const patch = await this.patch(repositoryPath, baseCommit, checkpointCommit, false);
    const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
    const sections = starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length).trimEnd());

    const files = changedFiles.map((file, index) => {
      const filePatch = sections[index] ?? "";
      const lines = filePatch.split("\n");
      const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      const statusCode = file.status.charAt(0);
      const statuses: Record<string, FileChangeStatus> = {
        A: "added",
        C: "copied",
        D: "deleted",
        M: "modified",
        R: "renamed",
        T: "type_changed",
      };
      return {
        status: statuses[statusCode] ?? "modified",
        statusCode: file.status,
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        additions,
        deletions,
        binary: filePatch.includes("Binary files") || filePatch.includes("GIT binary patch"),
        patch: filePatch,
      };
    });

    return {
      baseCommit,
      checkpointCommit,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      files,
    };
  }

  async parentCommit(repositoryPath: string, checkpointCommit: string): Promise<string> {
    return (await runChecked("git", ["rev-parse", `${checkpointCommit}^`], { cwd: repositoryPath })).stdout.trim();
  }

  async patch(repositoryPath: string, baseCommit: string, checkpointCommit: string, binary = true): Promise<string> {
    const argumentsList = ["diff", "--find-renames", "--no-ext-diff", "--no-color"];
    if (binary) argumentsList.push("--binary");
    argumentsList.push("--unified=3", `${baseCommit}..${checkpointCommit}`);
    return (await runChecked("git", argumentsList, { cwd: repositoryPath })).stdout;
  }

  relativePath(repositoryPath: string, absolutePath: string): string {
    return relative(repositoryPath, absolutePath);
  }
}

export const workspaceManager = new WorkspaceManager();
