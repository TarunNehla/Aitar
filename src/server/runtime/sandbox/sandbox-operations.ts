import { posix } from "node:path";
import { truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import type {
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  resolveWorkspacePath,
  sandbox,
  workspaceRelativePath,
  WORKSPACE_PATH,
} from "./sandbox.js";

const READ_LIMIT_BYTES = 8 * 1024 * 1024;
const WRITE_LIMIT_BYTES = 10 * 1024 * 1024;
const GREP_LIMIT_BYTES = 4 * 1024 * 1024;
const STAT_CACHE_MS = 2_000;
const DEFAULT_GREP_MATCHES = 100;

const imageMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern.slice(index, index + 3) === "**/") {
          source += "(?:[^/]*/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        const body = pattern.slice(index + 1, end);
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end + 1;
        continue;
      }
    }
    if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end !== -1) {
        const alternatives = pattern.slice(index + 1, end).split(",").map(escapeRegExp);
        source += `(?:${alternatives.join("|")})`;
        index = end + 1;
        continue;
      }
    }
    source += escapeRegExp(character as string);
    index += 1;
  }

  return new RegExp(`^${source}$`);
}

/** Bare patterns match a file name anywhere, patterns with a slash match the relative path. */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!pattern.includes("/")) return globToRegExp(pattern).test(posix.basename(relativePath));
  const normalised = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (globToRegExp(normalised).test(relativePath)) return true;
  if (normalised.startsWith("**/") || normalised.startsWith("/")) return false;
  return globToRegExp(`**/${normalised}`).test(relativePath);
}

export interface GrepRequest {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepOutcome {
  text: string;
  matches: number;
  files: number;
  truncated: boolean;
  matchLimitReached: boolean;
}

export interface ReadMetadata {
  path: string;
  bytes: number;
  lines: number;
}

export interface WriteMetadata {
  path: string;
  bytes: number;
}

/**
 * File operations for the pi tool factories. Every path is re-resolved against
 * /workspace and every byte is read or written by the chat's container, so the
 * host filesystem is never reachable through an agent-supplied path.
 */
export class SandboxOperations {
  lastRead: ReadMetadata | null = null;
  lastWrite: WriteMetadata | null = null;

  private readonly statCache = new Map<string, { kind: "file" | "directory" | null; at: number }>();
  private lastListing: { directory: string; entries: Map<string, boolean> } | null = null;

  constructor(
    private readonly chatId: string,
    private readonly repositoryPath: string,
  ) {}

  get read(): ReadOperations {
    return {
      readFile: async (absolutePath) => this.readFile(absolutePath),
      access: async (absolutePath) => this.accessFile(absolutePath),
      detectImageMimeType: async (absolutePath) =>
        imageMimeTypes[posix.extname(absolutePath).toLowerCase()] ?? null,
    };
  }

  get edit(): EditOperations {
    return {
      readFile: async (absolutePath) => this.readFile(absolutePath),
      writeFile: async (absolutePath, content) => this.writeFile(absolutePath, content),
      access: async (absolutePath) => this.accessFile(absolutePath),
    };
  }

  get write(): WriteOperations {
    return {
      writeFile: async (absolutePath, content) => this.writeFile(absolutePath, content),
      mkdir: async (directory) => {
        const path = resolveWorkspacePath(directory);
        await sandbox.exec(this.chatId, this.repositoryPath, ["mkdir", "-p", "--", path], { timeoutMs: 30_000 });
        this.statCache.delete(path);
      },
    };
  }

  get ls(): LsOperations {
    return {
      exists: async (absolutePath) => (await this.stat(absolutePath)) !== null,
      stat: async (absolutePath) => {
        const kind = await this.stat(absolutePath);
        if (!kind) throw new Error(`Path not found: ${workspaceRelativePath(absolutePath)}`);
        return { isDirectory: () => kind === "directory" };
      },
      readdir: async (absolutePath) => {
        const path = resolveWorkspacePath(absolutePath);
        const entries = await sandbox.readDirectory(this.chatId, this.repositoryPath, path);
        this.lastListing = {
          directory: path,
          entries: new Map(entries.map((entry) => [entry.name, entry.directory])),
        };
        return entries.map((entry) => entry.name);
      },
    };
  }

  get find(): FindOperations {
    return {
      exists: async (absolutePath) => (await this.stat(absolutePath)) !== null,
      glob: async (pattern, cwd, options) => {
        const root = resolveWorkspacePath(cwd);
        const files = await sandbox.listFiles(this.chatId, this.repositoryPath, root);
        const ignored = options.ignore.map((entry) => globToRegExp(entry));
        const matched: string[] = [];
        for (const file of files) {
          if (matched.length >= options.limit) break;
          if (ignored.some((expression) => expression.test(file))) continue;
          if (!matchesGlob(file, pattern)) continue;
          matched.push(posix.join(root, file));
        }
        return matched;
      },
    };
  }

  async grep(request: GrepRequest, signal?: AbortSignal): Promise<GrepOutcome> {
    const root = resolveWorkspacePath(request.path || ".");
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_GREP_MATCHES, 1_000));
    const context = Math.max(0, Math.min(request.context ?? 0, 20));
    const kind = await this.stat(root);
    if (!kind) throw new Error(`Path not found: ${workspaceRelativePath(root)}`);

    const grepArguments = [
      "grep", "-rnIHZ",
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      "--exclude-dir=.pnpm-store",
      ...(request.ignoreCase ? ["-i"] : []),
      request.literal ? "-F" : "-E",
      ...(context > 0 ? ["-C", String(context)] : []),
      "-e", request.pattern,
      "--", root,
    ];
    const result = await sandbox.exec(this.chatId, this.repositoryPath, grepArguments, {
      timeoutMs: 120_000,
      maxCapturedBytes: GREP_LIMIT_BYTES,
      signal,
    });
    if (result.exitCode > 1) {
      throw new Error(result.stderr.trim() || `grep exited with code ${result.exitCode}`);
    }

    const relativeRoot = kind === "directory" ? root : posix.dirname(root);
    const lines: string[] = [];
    const files = new Set<string>();
    let matches = 0;
    let matchLimitReached = false;
    let linesTruncated = false;

    for (const raw of result.stdout.split("\n")) {
      if (!raw) continue;
      const separator = raw.indexOf("\0");
      if (separator === -1) continue;
      const filePath = raw.slice(0, separator);
      const relativePath = posix.relative(relativeRoot, filePath) || posix.basename(filePath);
      if (request.glob && !matchesGlob(relativePath, request.glob)) continue;

      const remainder = raw.slice(separator + 1);
      const marker = remainder.search(/[:-]/);
      if (marker === -1) continue;
      const isMatch = remainder[marker] === ":";
      if (isMatch) {
        if (matches >= limit) {
          matchLimitReached = true;
          continue;
        }
        matches += 1;
        files.add(relativePath);
      }

      const lineNumber = remainder.slice(0, marker);
      const { text, wasTruncated } = truncateLine(remainder.slice(marker + 1));
      if (wasTruncated) linesTruncated = true;
      lines.push(`${relativePath}${isMatch ? ":" : "-"}${lineNumber}${isMatch ? ": " : "- "}${text}`);
    }

    if (matches === 0) {
      return { text: "No matches found.", matches: 0, files: 0, truncated: false, matchLimitReached: false };
    }

    const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    const notices: string[] = [];
    if (matchLimitReached) notices.push(`${limit} match limit reached`);
    if (truncation.truncated) notices.push("output size limit reached");
    if (linesTruncated) notices.push("some lines truncated");

    return {
      text: notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content,
      matches,
      files: files.size,
      truncated: truncation.truncated || matchLimitReached,
      matchLimitReached,
    };
  }

  private async stat(absolutePath: string): Promise<"file" | "directory" | null> {
    const path = resolveWorkspacePath(absolutePath);
    const listing = this.lastListing;
    if (listing && posix.dirname(path) === listing.directory) {
      const entry = listing.entries.get(posix.basename(path));
      if (entry !== undefined) return entry ? "directory" : "file";
    }

    const cached = this.statCache.get(path);
    if (cached && Date.now() - cached.at < STAT_CACHE_MS) return cached.kind;

    const kind = await sandbox.statPath(this.chatId, this.repositoryPath, path);
    this.statCache.set(path, { kind, at: Date.now() });
    return kind;
  }

  private async accessFile(absolutePath: string): Promise<void> {
    const kind = await this.stat(absolutePath);
    const relative = workspaceRelativePath(absolutePath);
    if (!kind) throw new Error(`File not found: ${relative}`);
    if (kind === "directory") throw new Error(`${relative} is a directory`);
  }

  private async readFile(absolutePath: string): Promise<Buffer> {
    const path = resolveWorkspacePath(absolutePath);
    const relative = workspaceRelativePath(path);
    const result = await sandbox.exec(this.chatId, this.repositoryPath, ["cat", "--", path], {
      timeoutMs: 60_000,
      binary: true,
      maxCapturedBytes: READ_LIMIT_BYTES,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot read ${relative}`);
    if (result.stdoutBytes > READ_LIMIT_BYTES) {
      throw new Error(
        `${relative} is ${result.stdoutBytes} bytes, larger than the ${READ_LIMIT_BYTES} byte read limit. Use bash with sed or head to inspect it.`,
      );
    }

    const buffer = result.stdoutBuffer ?? Buffer.alloc(0);
    this.lastRead = {
      path: relative,
      bytes: buffer.byteLength,
      lines: buffer.byteLength === 0 ? 0 : buffer.toString("utf8").split("\n").length,
    };
    return buffer;
  }

  private async writeFile(absolutePath: string, content: string): Promise<void> {
    const path = resolveWorkspacePath(absolutePath);
    const relative = workspaceRelativePath(path);
    const bytes = Buffer.byteLength(content);
    if (bytes > WRITE_LIMIT_BYTES) {
      throw new Error(`${relative} is larger than the ${WRITE_LIMIT_BYTES} byte write limit`);
    }

    const result = await sandbox.script(
      this.chatId,
      this.repositoryPath,
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      [path],
      { timeoutMs: 60_000, input: content },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Cannot write ${relative}`);
    this.statCache.delete(path);
    this.lastListing = null;
    this.lastWrite = { path: relative, bytes };
  }
}

export function sandboxWorkspaceRoot(): string {
  return WORKSPACE_PATH;
}
