import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { CodeChanges, FileChangeStatus } from "../../shared/contracts.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { browserSessions } from "./browser-session.js";
import { baseGitEnvironment } from "./git-credentials.js";
import { runChecked } from "./process.js";
import { sandbox } from "./sandbox.js";
import { processManager } from "./sandbox-processes.js";

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
    throw new Error("Aitar supports HTTPS GitHub repositories only");
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

async function hostGit(args: string[], options: Parameters<typeof runChecked>[2] = {}) {
  return runChecked("git", [...HOST_GIT_PREFIX, ...args], {
    ...options,
    env: { ...baseGitEnvironment(), ...options.env },
  });
}

export interface RemoteGitAccess {
  gitEnvironment?: NodeJS.ProcessEnv;
}

export class WorkspaceManager {
  async prepareRepository(input: RemoteGitAccess & { repositoryId: string; repositoryUrl: string; baseBranch: string }) {
    const baseCommit = await this.ensureMirror(input);
    return { mirrorPath: repositoryMirrorPath(input.repositoryId), baseCommit };
  }

  async prepareChat(input: RemoteGitAccess & {
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

  async ensureChatCheckout(input: RemoteGitAccess & {
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

  /** The container is the only place agent-requested file work happens. */
  async ensureSandbox(chatId: string, repositoryPath: string): Promise<string> {
    await this.ensurePlatformGitExcludes(repositoryPath);
    return sandbox.ensureContainer(chatId, repositoryPath);
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
    await processManager.stopAll(input.chatId);
    await browserSessions.close(input.chatId);
    await sandbox.removeContainer(input.chatId);
    await rm(location.root, { recursive: true, force: true });
  }

  relativePath(repositoryPath: string, absolutePath: string): string {
    return relative(repositoryPath, absolutePath);
  }

  private async ensureMirror(input: RemoteGitAccess & { repositoryId: string; repositoryUrl: string; baseBranch: string }) {
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
      { cwd: mirrorPath, timeoutMs: 120_000, env: input.gitEnvironment },
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
