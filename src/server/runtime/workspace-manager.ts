import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CodeChanges, FileChangeStatus } from "../../shared/contracts.js";
import { config } from "../config.js";
import { errorForLog, logger } from "../logger.js";
import { runChecked, runProcess, type ProcessResult } from "./process.js";

const workspaceLogger = logger.child({ component: "workspace-manager" });
const HOST_GIT_PREFIX = [
  "-c", "core.hooksPath=/var/empty",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.ext.allow=never",
];
const PLATFORM_GIT_EXCLUDES = [
  "node_modules/",
  ".pnpm-store/",
  ".npm/",
  ".yarn/cache/",
  ".yarn/unplugged/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "target/",
  ".gradle/",
  ".next/",
  ".nuxt/",
  ".vite/",
  ".turbo/",
  ".cache/",
  "coverage/",
  ".env",
  ".env.local",
  ".env.*.local",
];

export interface ChatLocation {
  root: string;
  repository: string;
}

export function repositoryMirrorPath(repositoryId: string): string {
  return join(config.WORKSPACE_ROOT, "repos", `${repositoryId}.git`);
}

export function chatLocation(chatId: string): ChatLocation {
  const root = join(config.WORKSPACE_ROOT, "chats", chatId);
  return { root, repository: join(root, "repository") };
}

export function chatBranchName(chatId: string): string {
  return `agent/${chatId}`;
}

export function chatInternalRef(chatId: string): string {
  return `refs/cloud-agents/chats/${chatId}`;
}

export function validateRepositoryUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("V0 supports public HTTPS GitHub repositories only");
  }
  if (url.username || url.password) throw new Error("Repository URLs must not contain credentials");
  if (url.pathname.split("/").filter(Boolean).length !== 2) {
    throw new Error("Repository URL must contain an owner and repository name");
  }
  return url;
}

export function validateBranchName(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error("Invalid Git branch name");
  }
  return value;
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

function containerName(chatId: string): string {
  return `cloud-agent-${chatId}`;
}

async function hostGit(args: string[], options: Parameters<typeof runChecked>[2] = {}) {
  return runChecked("git", [...HOST_GIT_PREFIX, ...args], options);
}

export class WorkspaceManager {
  async prepareRepository(input: { repositoryId: string; repositoryUrl: string; baseBranch: string }) {
    const baseCommit = await this.ensureMirror(input);
    return { mirrorPath: repositoryMirrorPath(input.repositoryId), baseCommit };
  }

  async prepareChat(input: {
    chatId: string;
    repositoryId: string;
    repositoryUrl: string;
    baseBranch: string;
    branchName: string;
  }) {
    const startedAt = Date.now();
    validateBranchName(input.baseBranch);
    validateBranchName(input.branchName);
    const baseCommit = await this.ensureMirror(input);
    const location = chatLocation(input.chatId);
    const mirrorPath = repositoryMirrorPath(input.repositoryId);
    await mkdir(location.root, { recursive: true });

    await hostGit(["clone", "--local", "--no-checkout", "--", mirrorPath, location.repository]);
    await hostGit(["checkout", "-b", input.branchName, baseCommit], { cwd: location.repository });
    await hostGit(["config", "user.name", "Cloud Agent"], { cwd: location.repository });
    await hostGit(["config", "user.email", "cloud-agent@local"], { cwd: location.repository });
    await this.ensurePlatformGitExcludes(location.repository);
    await hostGit(["update-ref", chatInternalRef(input.chatId), baseCommit], { cwd: mirrorPath });

    workspaceLogger.info(
      { chatId: input.chatId, repositoryId: input.repositoryId, durationMs: Date.now() - startedAt },
      "Chat checkout prepared",
    );
    return { ...location, baseCommit, headCommit: baseCommit };
  }

  async ensureChatCheckout(input: {
    chatId: string;
    repositoryId: string;
    repositoryUrl: string;
    baseBranch: string;
    branchName: string;
    headCommit: string;
    legacyWorkspaceId?: string;
  }): Promise<ChatLocation> {
    const location = chatLocation(input.chatId);
    try {
      await stat(join(location.repository, ".git"));
      return location;
    } catch {
      // Restore the disposable checkout from the protected repository mirror.
    }

    const mirrorPath = repositoryMirrorPath(input.repositoryId);
    try {
      await stat(join(mirrorPath, "HEAD"));
    } catch {
      await this.ensureMirror(input);
    }
    const ref = chatInternalRef(input.chatId);
    let restoreCommit = input.headCommit;
    try {
      restoreCommit = (await hostGit(["rev-parse", `${ref}^{commit}`], { cwd: mirrorPath })).stdout.trim();
    } catch {
      try {
        await hostGit(["cat-file", "-e", `${input.headCommit}^{commit}`], { cwd: mirrorPath });
      } catch {
        if (!input.legacyWorkspaceId) throw new Error("Chat checkpoint is missing from the repository mirror");
        const candidates = [
          join(config.WORKSPACE_ROOT, "workspaces", input.legacyWorkspaceId, "repository"),
          join(config.WORKSPACE_ROOT, input.legacyWorkspaceId, "repository"),
        ];
        let imported = false;
        for (const legacyRepository of candidates) {
          try {
            await stat(join(legacyRepository, ".git"));
            await hostGit(
              ["-c", "protocol.file.allow=always", "fetch", "--no-tags", legacyRepository, `${input.headCommit}:${ref}`],
              { cwd: mirrorPath },
            );
            imported = true;
            break;
          } catch {
            // Try the other legacy layout.
          }
        }
        if (!imported) throw new Error("Legacy chat checkout could not be imported");
      }
      await hostGit(["update-ref", ref, input.headCommit], { cwd: mirrorPath });
    }

    await mkdir(location.root, { recursive: true });
    await hostGit(["clone", "--local", "--no-checkout", "--", mirrorPath, location.repository]);
    await hostGit(["checkout", "-b", input.branchName, restoreCommit], { cwd: location.repository });
    await hostGit(["config", "user.name", "Cloud Agent"], { cwd: location.repository });
    await hostGit(["config", "user.email", "cloud-agent@local"], { cwd: location.repository });
    await this.ensurePlatformGitExcludes(location.repository);
    return location;
  }

  async ensureSandbox(chatId: string, repositoryPath: string): Promise<string> {
    await this.ensurePlatformGitExcludes(repositoryPath);
    const name = containerName(chatId);
    const inspected = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 10_000 });
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return name;
    if (inspected.exitCode === 0) {
      await runChecked("docker", ["start", name], { timeoutMs: 30_000 });
      return name;
    }

    await runChecked("docker", [
      "run", "-d", "--name", name,
      "--workdir", "/workspace",
      "--mount", `type=bind,src=${repositoryPath},dst=/workspace`,
      "--memory", `${config.SANDBOX_MEMORY_MB}m`,
      "--cpus", String(config.SANDBOX_CPUS),
      "--pids-limit", "256",
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      config.SANDBOX_IMAGE,
      "sleep", "infinity",
    ], { timeoutMs: 120_000 });
    return name;
  }

  async execute(
    chatId: string,
    repositoryPath: string,
    command: string,
    options: {
      signal?: AbortSignal;
      network?: boolean;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      captureTail?: boolean;
    } = {},
  ): Promise<ProcessResult> {
    const startedAt = Date.now();
    const common = {
      signal: options.signal,
      timeoutMs: config.SANDBOX_TIMEOUT_SECONDS * 1_000,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      captureTail: options.captureTail,
    };

    try {
      const result = options.network
        ? await runProcess("docker", [
            "run", "--rm", "--workdir", "/workspace",
            "--mount", `type=bind,src=${repositoryPath},dst=/workspace`,
            "--memory", `${config.SANDBOX_MEMORY_MB}m`,
            "--cpus", String(config.SANDBOX_CPUS),
            "--pids-limit", "256",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true",
            config.SANDBOX_IMAGE,
            "sh", "-lc", command,
          ], common)
        : await runProcess(
            "docker",
            ["exec", await this.ensureSandbox(chatId, repositoryPath), "sh", "-lc", command],
            common,
          );
      const data = {
        chatId,
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
        { error: errorForLog(error), chatId, network: Boolean(options.network), durationMs: Date.now() - startedAt },
        "Sandbox command could not complete",
      );
      throw error;
    }
  }

  async listFiles(repositoryPath: string, limit = 500): Promise<string[]> {
    const result = await hostGit(["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repositoryPath });
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

  async checkpoint(input: {
    chatId: string;
    repositoryId: string;
    repositoryPath: string;
    runId: string;
    baseCommit: string;
  }) {
    await this.ensurePlatformGitExcludes(input.repositoryPath);
    await hostGit(["add", "-A"], { cwd: input.repositoryPath });
    const clean = await hostGit(["diff", "--cached", "--quiet"], { cwd: input.repositoryPath }).catch(() => null);
    const createdCommit = !clean;
    if (createdCommit) {
      await hostGit(["commit", "--no-verify", "-m", `checkpoint: ${input.runId}`], { cwd: input.repositoryPath });
    }

    const checkpointCommit = (await hostGit(["rev-parse", "HEAD"], { cwd: input.repositoryPath })).stdout.trim();
    const internalRef = chatInternalRef(input.chatId);
    if (createdCommit) {
      const mirrorPath = repositoryMirrorPath(input.repositoryId);
      await hostGit(
        ["-c", "protocol.file.allow=always", "push", "--force", "--", mirrorPath, `HEAD:${internalRef}`],
        { cwd: input.repositoryPath },
      );
      const mirroredCommit = (await hostGit(["rev-parse", `${internalRef}^{commit}`], { cwd: mirrorPath })).stdout.trim();
      if (mirroredCommit !== checkpointCommit) throw new Error("Git checkpoint mirror verification failed");
    }

    const changedFiles = createdCommit
      ? await this.changedFiles(input.repositoryPath, input.baseCommit, checkpointCommit)
      : [];
    return { checkpointCommit, internalRef, createdCommit, changedFiles };
  }

  async changedFiles(repositoryPath: string, baseCommit: string, checkpointCommit = "HEAD") {
    const result = await hostGit(
      ["diff", "--find-renames", "--name-status", "-z", `${baseCommit}..${checkpointCommit}`],
      { cwd: repositoryPath },
    );
    const parts = result.stdout.split("\0");
    const files: Array<{ status: string; path: string; previousPath?: string }> = [];
    let index = 0;
    while (index < parts.length && parts[index]) {
      const status = parts[index++] ?? "M";
      if (status.startsWith("R") || status.startsWith("C")) {
        files.push({ status, previousPath: parts[index++] ?? "", path: parts[index++] ?? "" });
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
      const statusCode = file.status.charAt(0);
      const statuses: Record<string, FileChangeStatus> = {
        A: "added", C: "copied", D: "deleted", M: "modified", R: "renamed", T: "type_changed",
      };
      return {
        status: statuses[statusCode] ?? "modified",
        statusCode: file.status,
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
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
    return (await hostGit(["rev-parse", `${checkpointCommit}^`], { cwd: repositoryPath })).stdout.trim();
  }

  async patch(repositoryPath: string, baseCommit: string, checkpointCommit: string, binary = true): Promise<string> {
    const args = ["diff", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
    if (binary) args.push("--binary");
    args.push("--unified=3", `${baseCommit}..${checkpointCommit}`);
    return (await hostGit(args, { cwd: repositoryPath })).stdout;
  }

  async evictChat(input: { chatId: string; repositoryId: string; expectedHeadCommit: string }): Promise<void> {
    const location = chatLocation(input.chatId);
    const mirrorPath = repositoryMirrorPath(input.repositoryId);
    const mirrored = (await hostGit(["rev-parse", `${chatInternalRef(input.chatId)}^{commit}`], { cwd: mirrorPath })).stdout.trim();
    if (mirrored !== input.expectedHeadCommit) throw new Error("Chat branch is not safely mirrored");
    try {
      await stat(join(location.repository, ".git"));
      const status = await hostGit(["status", "--porcelain"], { cwd: location.repository });
      if (status.stdout.trim()) throw new Error("Chat checkout has uncheckpointed changes");
    } catch (error) {
      if (error instanceof Error && error.message === "Chat checkout has uncheckpointed changes") throw error;
    }
    await runProcess("docker", ["rm", "-f", containerName(input.chatId)], { timeoutMs: 30_000 });
    await rm(location.root, { recursive: true, force: true });
  }

  relativePath(repositoryPath: string, absolutePath: string): string {
    return relative(repositoryPath, absolutePath);
  }

  private async ensureMirror(input: { repositoryId: string; repositoryUrl: string; baseBranch: string }) {
    const url = validateRepositoryUrl(input.repositoryUrl);
    const baseBranch = validateBranchName(input.baseBranch);
    const mirrorPath = repositoryMirrorPath(input.repositoryId);
    await mkdir(dirname(mirrorPath), { recursive: true });
    try {
      await stat(join(mirrorPath, "HEAD"));
    } catch {
      await hostGit(["init", "--bare", mirrorPath]);
      await hostGit(["remote", "add", "origin", url.toString()], { cwd: mirrorPath });
    }
    await hostGit(["remote", "set-url", "origin", url.toString()], { cwd: mirrorPath });
    await hostGit(
      ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      { cwd: mirrorPath, timeoutMs: 120_000 },
    );
    return (await hostGit(["rev-parse", `refs/remotes/origin/${baseBranch}^{commit}`], { cwd: mirrorPath })).stdout.trim();
  }

  private async ensurePlatformGitExcludes(repositoryPath: string): Promise<void> {
    const excludePath = join(repositoryPath, ".git", "info", "exclude");
    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch {
      // A normal clone creates this file, but creating it is safe when absent.
    }
    const patterns = new Set(existing.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
    const missing = PLATFORM_GIT_EXCLUDES.filter((pattern) => !patterns.has(pattern));
    if (missing.length === 0) return;
    await mkdir(dirname(excludePath), { recursive: true });
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(
      excludePath,
      `${existing}${separator}# Cloud Agents platform exclusions\n${missing.join("\n")}\n`,
      "utf8",
    );
  }
}

export const workspaceManager = new WorkspaceManager();
