import { posix } from "node:path";
import { config } from "../../config.js";
import { errorForLog, logger } from "../../logger.js";
import { runChecked, runProcess, type ProcessResult } from "../process.js";

const sandboxLogger = logger.child({ component: "sandbox" });

export const WORKSPACE_PATH = "/workspace";
export const SANDBOX_STATE_PATH = "/tmp/cloud-agent";

export function containerName(chatId: string): string {
  return `cloud-agent-${chatId}`;
}

export function resolveWorkspacePath(requestedPath: string): string {
  if (requestedPath.includes("\0")) throw new Error("Invalid path");
  const resolved = posix.resolve(WORKSPACE_PATH, requestedPath || ".");
  if (resolved !== WORKSPACE_PATH && !resolved.startsWith(`${WORKSPACE_PATH}/`)) {
    throw new Error(`Paths must stay inside ${WORKSPACE_PATH}`);
  }
  return resolved;
}

export function workspaceRelativePath(absolutePath: string): string {
  const relative = posix.relative(WORKSPACE_PATH, resolveWorkspacePath(absolutePath));
  return relative || ".";
}

export function parseProcessTable(text: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of text.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/);
    const pidNumber = Number(pid);
    const parentNumber = Number(parent);
    if (Number.isInteger(pidNumber) && Number.isInteger(parentNumber) && pidNumber > 0) {
      table.set(pidNumber, parentNumber);
    }
  }
  return table;
}

/** Depth-first walk so a cancelled command takes every descendant with it. */
export function processTreePids(table: Map<number, number>, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of table) {
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }

  const collected: number[] = [];
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    if (seen.has(pid) || pid <= 1) continue;
    seen.add(pid);
    collected.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return collected;
}

const PROCESS_TABLE_SCRIPT = `for entry in /proc/[0-9]*; do
  pid=\${entry#/proc/}
  parent=$(sed -e 's/^[0-9]* (.*) [A-Za-z] //' "$entry/stat" 2>/dev/null | cut -d' ' -f1)
  [ -n "$parent" ] && printf '%s %s\\n' "$pid" "$parent"
done`;

const READDIR_SCRIPT = `cd -- "$1" 2>/dev/null || exit 3
for name in * .[!.]* ..?*; do
  [ -e "$name" ] || [ -L "$name" ] || continue
  if [ -d "$name" ]; then printf 'd %s\\0' "$name"; else printf 'f %s\\0' "$name"; fi
done`;

const STAT_SCRIPT = `if [ -d "$1" ]; then printf 'directory'
elif [ -e "$1" ]; then printf 'file'
else exit 3
fi`;

const LIST_FILES_SCRIPT = `cd -- "$1" 2>/dev/null || exit 3
find . \\( -name node_modules -o -name .git -o -name .pnpm-store \\) -prune -o -type f -print0 2>/dev/null | head -c "$2"`;

/**
 * The host uid keeps bind-mounted repository writes working while staying off root.
 * A root server process falls back to the conventional unprivileged image user.
 */
function containerUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (uid === undefined || gid === undefined || uid === 0) return "1000:1000";
  return `${uid}:${gid}`;
}

function isolationArguments(): string[] {
  return [
    "--workdir", WORKSPACE_PATH,
    "--user", containerUser(),
    "--memory", `${config.SANDBOX_MEMORY_MB}m`,
    "--memory-swap", `${config.SANDBOX_MEMORY_MB}m`,
    "--cpus", String(config.SANDBOX_CPUS),
    "--pids-limit", String(config.SANDBOX_PIDS_LIMIT),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--env", "HOME=/tmp",
  ];
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string | Buffer;
  binary?: boolean;
  maxCapturedBytes?: number;
  captureTail?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class Sandbox {
  private readonly starting = new Map<string, Promise<string>>();

  async ensureContainer(chatId: string, repositoryPath: string): Promise<string> {
    const existing = this.starting.get(chatId);
    if (existing) return existing;

    const started = this.startContainer(chatId, repositoryPath).finally(() => {
      this.starting.delete(chatId);
    });
    this.starting.set(chatId, started);
    return started;
  }

  async removeContainer(chatId: string): Promise<void> {
    await runProcess("docker", ["rm", "-f", containerName(chatId)], { timeoutMs: 60_000 });
  }

  /** Runs an argument vector inside the chat container without a shell. */
  async exec(
    chatId: string,
    repositoryPath: string,
    commandArguments: string[],
    options: ExecOptions = {},
  ): Promise<ProcessResult> {
    const container = await this.ensureContainer(chatId, repositoryPath);
    const dockerArguments = ["exec", ...(options.input === undefined ? [] : ["-i"]), container, ...commandArguments];
    return runProcess("docker", dockerArguments, {
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
      input: options.input,
      binary: options.binary,
      maxCapturedBytes: options.maxCapturedBytes,
      captureTail: options.captureTail,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  /** Runs a POSIX shell script inside the chat container with positional arguments. */
  async script(
    chatId: string,
    repositoryPath: string,
    script: string,
    scriptArguments: string[] = [],
    options: ExecOptions = {},
  ): Promise<ProcessResult> {
    return this.exec(chatId, repositoryPath, ["sh", "-c", script, "sh", ...scriptArguments], options);
  }

  async detach(chatId: string, repositoryPath: string, script: string, scriptArguments: string[] = []): Promise<void> {
    const container = await this.ensureContainer(chatId, repositoryPath);
    await runChecked(
      "docker",
      ["exec", "-d", container, "sh", "-c", script, "sh", ...scriptArguments],
      { timeoutMs: 30_000 },
    );
  }

  async statPath(chatId: string, repositoryPath: string, absolutePath: string): Promise<"file" | "directory" | null> {
    const result = await this.script(chatId, repositoryPath, STAT_SCRIPT, [resolveWorkspacePath(absolutePath)], {
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() === "directory" ? "directory" : "file";
  }

  async readDirectory(
    chatId: string,
    repositoryPath: string,
    absolutePath: string,
  ): Promise<Array<{ name: string; directory: boolean }>> {
    const result = await this.script(chatId, repositoryPath, READDIR_SCRIPT, [resolveWorkspacePath(absolutePath)], {
      timeoutMs: 60_000,
      maxCapturedBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(`Cannot read directory: ${workspaceRelativePath(absolutePath)}`);
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ name: entry.slice(2), directory: entry.startsWith("d ") }));
  }

  async listFiles(chatId: string, repositoryPath: string, absolutePath: string, maxBytes = 4 * 1024 * 1024) {
    const result = await this.script(
      chatId,
      repositoryPath,
      LIST_FILES_SCRIPT,
      [resolveWorkspacePath(absolutePath), String(maxBytes)],
      { timeoutMs: 120_000, maxCapturedBytes: maxBytes + 1024 },
    );
    if (result.exitCode !== 0) throw new Error(`Path not found: ${workspaceRelativePath(absolutePath)}`);
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => (entry.startsWith("./") ? entry.slice(2) : entry));
  }

  /** Terminates a container process and everything it spawned. */
  async killProcessTree(chatId: string, repositoryPath: string, rootPid: number, signal: "TERM" | "KILL") {
    try {
      const table = await this.script(chatId, repositoryPath, PROCESS_TABLE_SCRIPT, [], {
        timeoutMs: 30_000,
        maxCapturedBytes: 1024 * 1024,
      });
      const pids = processTreePids(parseProcessTable(table.stdout), rootPid);
      if (pids.length === 0) return [];
      await this.exec(chatId, repositoryPath, ["kill", `-${signal}`, ...pids.map(String)], { timeoutMs: 30_000 });
      return pids;
    } catch (error) {
      sandboxLogger.warn({ error: errorForLog(error), chatId, rootPid, signal }, "Sandbox process tree kill failed");
      return [];
    }
  }

  private async startContainer(chatId: string, repositoryPath: string): Promise<string> {
    const name = containerName(chatId);
    const inspected = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 15_000 });
    if (inspected.exitCode === 0 && inspected.stdout.trim() === "true") return name;
    if (inspected.exitCode === 0) {
      await runChecked("docker", ["start", name], { timeoutMs: 60_000 });
      return name;
    }

    const baseArguments = [
      "run", "-d", "--name", name,
      "--mount", `type=bind,src=${repositoryPath},dst=${WORKSPACE_PATH}`,
      ...isolationArguments(),
    ];
    const tail = [config.SANDBOX_IMAGE, "sleep", "infinity"];
    const diskArguments = ["--storage-opt", `size=${config.SANDBOX_DISK_GB}G`];

    const withDiskQuota = await runProcess("docker", [...baseArguments, ...diskArguments, ...tail], {
      timeoutMs: 180_000,
    });
    if (withDiskQuota.exitCode === 0) {
      sandboxLogger.info({ chatId, diskQuotaGb: config.SANDBOX_DISK_GB }, "Chat container started");
      return name;
    }

    sandboxLogger.info(
      { chatId, reason: withDiskQuota.stderr.trim().slice(0, 200) },
      "Storage quotas are unsupported on this Docker storage driver",
    );
    await runProcess("docker", ["rm", "-f", name], { timeoutMs: 30_000 });
    await runChecked("docker", [...baseArguments, ...tail], { timeoutMs: 180_000 });
    sandboxLogger.info({ chatId, diskQuotaGb: null }, "Chat container started");
    return name;
  }
}

export const sandbox = new Sandbox();
