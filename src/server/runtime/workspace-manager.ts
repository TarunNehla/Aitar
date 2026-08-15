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

export interface ChatCheckout extends ChatLocation {
  baseCommit: string;
  headCommit: string;
  created: boolean;
}

export function repositoryMirrorPath(repositoryId: string): string {
  return join(config.WORKSPACE_ROOT, "repos", `${repositoryId}.git`);
}

export function chatLocation(chatId: string): ChatLocation {
  const root = join(config.WORKSPACE_ROOT, "chats", chatId);
  return { root, repository: join(root, "repository") };
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
  async prepareRepository(input: RemoteGitAccess & {
    repositoryId: string;
    repositoryUrl: string;
    defaultBranch?: string;
  }) {
    const mirrorPath = await this.ensureMirror(input);
    const defaultBranch = input.defaultBranch
      ? validateBranchName(input.defaultBranch)
      : await this.remoteDefaultBranch(mirrorPath, input.gitEnvironment);
    const baseCommit = await this.branchCommit(mirrorPath, defaultBranch);
    return { mirrorPath, defaultBranch, baseCommit };
  }

  /** Fetches the mirror and answers where the requested base branch currently points. */
  async resolveBaseBranch(input: RemoteGitAccess & {
    repositoryId: string;
    repositoryUrl: string;
    branch: string;
  }): Promise<string> {
    const branch = validateBranchName(input.branch);
    const mirrorPath = await this.ensureMirror(input);
    return this.branchCommit(mirrorPath, branch);
  }

  async checkoutExists(chatId: string): Promise<boolean> {
    try {
      await stat(join(chatLocation(chatId).repository, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates the chat's disposable checkout the first time the agent needs the
   * repository, and restores it at the stored checkpoint after an eviction.
   * The checkout always sits on a detached HEAD: a chat owns commits, never a branch.
   */
  async ensureChatCheckout(input: RemoteGitAccess & {
    chatId: string;
    repositoryId: string;
    repositoryUrl: string;
    baseBranch: string;
    baseCommit?: string | null;
    headCommit?: string | null;
  }): Promise<ChatCheckout> {
    const startedAt = Date.now();
    const location = chatLocation(input.chatId);
    const present = await this.checkoutExists(input.chatId);
    if (present && input.baseCommit && input.headCommit) {
      return { ...location, baseCommit: input.baseCommit, headCommit: input.headCommit, created: false };
    }
    if (present) await this.discardChatCheckout(input.chatId);

    const mirrorPath = repositoryMirrorPath(input.repositoryId);
    const baseBranch = validateBranchName(input.baseBranch);
    let mirrored = true;
    try {
      await stat(join(mirrorPath, "HEAD"));
    } catch {
      mirrored = false;
    }
    if (!mirrored || !input.baseCommit) await this.ensureMirror(input);
    const baseCommit = input.baseCommit || (await this.branchCommit(mirrorPath, baseBranch));

    const ref = chatInternalRef(input.chatId);
    const headCommit = input.headCommit
      ? await this.restorableCommit({ ...input, mirrorPath, ref, headCommit: input.headCommit })
      : baseCommit;
    if (!input.headCommit) await hostGit(["update-ref", ref, baseCommit], { cwd: mirrorPath });

    await mkdir(location.root, { recursive: true });
    await hostGit(["clone", "--local", "--no-checkout", "--", mirrorPath, location.repository]);
    await hostGit(["-c", "advice.detachedHead=false", "checkout", "--detach", headCommit], {
      cwd: location.repository,
    });
    await hostGit(["config", "user.name", "Cloud Agent"], { cwd: location.repository });
    await hostGit(["config", "user.email", "cloud-agent@local"], { cwd: location.repository });
    await this.ensurePlatformGitExcludes(location.repository);

    workspaceLogger.info(
      { chatId: input.chatId, repositoryId: input.repositoryId, restored: Boolean(input.headCommit), durationMs: Date.now() - startedAt },
      "Chat checkout prepared on a detached HEAD",
    );
    return { ...location, baseCommit, headCommit, created: true };
  }

  /** True when the checkout carries work the platform has not committed yet. */
  async hasTrackedChanges(repositoryPath: string): Promise<boolean> {
    try {
      await stat(join(repositoryPath, ".git"));
    } catch {
      return false;
    }
    await this.ensurePlatformGitExcludes(repositoryPath);
    const status = await hostGit(["status", "--porcelain"], { cwd: repositoryPath });
    return status.stdout.trim().length > 0;
  }

  /** Stops everything attached to a chat checkout and removes the directory. */
  async discardChatCheckout(chatId: string): Promise<void> {
    await processManager.stopAll(chatId);
    await browserSessions.close(chatId);
    await sandbox.removeContainer(chatId);
    await rm(chatLocation(chatId).root, { recursive: true, force: true });
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
    if (mirrored !== input.expectedHeadCommit) throw new Error("Chat checkpoint is not safely mirrored");
    // The mirror already holds this chat's work, so a checkout Git cannot read is still disposable.
    if (await this.hasTrackedChanges(location.repository).catch(() => false)) {
      throw new Error("Chat checkout has uncheckpointed changes");
    }
    await this.discardChatCheckout(input.chatId);
  }

  relativePath(repositoryPath: string, absolutePath: string): string {
    return relative(repositoryPath, absolutePath);
  }

  /** The checkpoint ref is the durable record, so it outranks a stored commit that fell behind. */
  private async restorableCommit(input: { mirrorPath: string; ref: string; headCommit: string }): Promise<string> {
    const fromRef = await hostGit(["rev-parse", `${input.ref}^{commit}`], { cwd: input.mirrorPath }).catch(() => null);
    if (fromRef) return fromRef.stdout.trim();

    const present = await hostGit(["cat-file", "-e", `${input.headCommit}^{commit}`], { cwd: input.mirrorPath })
      .catch(() => null);
    if (!present) throw new Error("Chat checkpoint is missing from the repository mirror");

    await hostGit(["update-ref", input.ref, input.headCommit], { cwd: input.mirrorPath });
    return input.headCommit;
  }

  private async ensureMirror(input: RemoteGitAccess & { repositoryId: string; repositoryUrl: string }) {
    const url = validateRepositoryUrl(input.repositoryUrl);
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
    return mirrorPath;
  }

  private async remoteDefaultBranch(mirrorPath: string, gitEnvironment?: NodeJS.ProcessEnv): Promise<string> {
    const listed = await hostGit(["ls-remote", "--symref", "origin", "HEAD"], {
      cwd: mirrorPath,
      timeoutMs: 60_000,
      env: gitEnvironment,
    });
    const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(listed.stdout)?.[1];
    if (!branch) throw new Error("That repository has no default branch to start from");
    return validateBranchName(branch);
  }

  private async branchCommit(mirrorPath: string, branch: string): Promise<string> {
    try {
      const resolved = await hostGit(["rev-parse", `refs/remotes/origin/${branch}^{commit}`], { cwd: mirrorPath });
      return resolved.stdout.trim();
    } catch {
      throw new Error(`Branch ${branch} is not in this repository`);
    }
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
