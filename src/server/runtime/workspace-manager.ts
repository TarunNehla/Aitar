import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { runChecked, runProcess, type ProcessResult } from "./process.js";

export interface WorkspaceLocation {
  root: string;
  repository: string;
  artifacts: string;
}

export function workspaceLocation(workspaceId: string): WorkspaceLocation {
  const root = join(config.WORKSPACE_ROOT, workspaceId);
  return {
    root,
    repository: join(root, "repository"),
    artifacts: join(root, "artifacts"),
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
    const url = validateRepositoryUrl(input.repositoryUrl);
    const location = workspaceLocation(input.workspaceId);
    await mkdir(location.root, { recursive: true });
    await mkdir(location.artifacts, { recursive: true });

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
    return { ...location, baseCommit };
  }

  async ensureSandbox(workspaceId: string, repositoryPath: string): Promise<string> {
    const name = containerName(workspaceId);
    const inspected = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 10_000 });
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return name;

    if (inspected.exitCode === 0) {
      await runChecked("docker", ["start", name], { timeoutMs: 30_000 });
      return name;
    }

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
    const common = {
      signal: options.signal,
      timeoutMs: config.SANDBOX_TIMEOUT_SECONDS * 1_000,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    };

    if (options.network) {
      return runProcess(
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
    }

    const name = await this.ensureSandbox(workspaceId, repositoryPath);
    return runProcess("docker", ["exec", name, "sh", "-lc", command], common);
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

    if (!staged) {
      await runChecked("git", ["commit", "--no-verify", "-m", `checkpoint: ${input.runId}`], {
        cwd: input.repositoryPath,
      });
    }

    const checkpointCommit = (
      await runChecked("git", ["rev-parse", "HEAD"], { cwd: input.repositoryPath })
    ).stdout.trim();
    const internalRef = `refs/heads/cloud-agent/${input.workspaceId}`;
    const patch = (
      await runChecked("git", ["diff", "--binary", `${input.baseCommit}..${checkpointCommit}`], {
        cwd: input.repositoryPath,
      })
    ).stdout;
    const location = workspaceLocation(input.workspaceId);
    await mkdir(location.artifacts, { recursive: true });
    const patchPath = join(location.artifacts, `${input.runId}-${checkpointCommit.slice(0, 8)}.patch`);
    await writeFile(patchPath, patch, "utf8");

    return {
      checkpointCommit,
      internalRef,
      patchPath,
      patchSize: Buffer.byteLength(patch),
      changedFiles: await this.changedFiles(input.repositoryPath, input.baseCommit, checkpointCommit),
    };
  }

  async changedFiles(repositoryPath: string, baseCommit: string, checkpointCommit = "HEAD") {
    const result = await runChecked("git", ["diff", "--name-status", `${baseCommit}..${checkpointCommit}`], {
      cwd: repositoryPath,
    });
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...parts] = line.split("\t");
        return { status, path: parts.at(-1) ?? "" };
      });
  }

  relativePath(repositoryPath: string, absolutePath: string): string {
    return relative(repositoryPath, absolutePath);
  }
}

export const workspaceManager = new WorkspaceManager();
