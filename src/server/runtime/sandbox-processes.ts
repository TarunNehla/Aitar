import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { errorForLog, logger } from "../logger.js";
import { publishTransient } from "./event-writer.js";
import { sandbox, SANDBOX_STATE_PATH } from "./sandbox.js";

const processLogger = logger.child({ component: "sandbox-processes" });

const PROCESS_ROOT = `${SANDBOX_STATE_PATH}/processes`;
const LOG_CHUNK_LIMIT = 32_000;
const STREAM_INTERVAL_MS = 1_000;
const STREAM_CHUNK_LIMIT = 8_000;

const START_SCRIPT = `mkdir -p -- "$1" || exit 1
cd /workspace || exit 1
sh -c 'printf "%s" "$$" > "$0/pid"; exec sh -lc "$1"' "$1" "$2" > "$1/stdout" 2> "$1/stderr"
printf '%s' "$?" > "$1/exit"`;

const READ_SCRIPT = `directory=$1
stdoutSize=$(wc -c < "$directory/stdout" 2>/dev/null || printf 0)
stderrSize=$(wc -c < "$directory/stderr" 2>/dev/null || printf 0)
state=running
code=-
if [ -f "$directory/exit" ]; then
  state=exited
  code=$(cat "$directory/exit" 2>/dev/null || printf -)
fi
printf '%s %s %s %s\\n' "$stdoutSize" "$stderrSize" "$state" "$code"
printf '\\0OUT\\0'
tail -c +$(($2 + 1)) "$directory/stdout" 2>/dev/null | head -c "$4"
printf '\\0ERR\\0'
tail -c +$(($3 + 1)) "$directory/stderr" 2>/dev/null | head -c "$4"`;

export type ProcessState = "running" | "exited" | "stopped";

interface ManagedProcess {
  id: string;
  chatId: string;
  repositoryPath: string;
  name: string;
  command: string;
  directory: string;
  startedAt: number;
  state: ProcessState;
  exitCode: number | null;
  streamedStdout: number;
  streamedStderr: number;
}

export interface ProcessLogs {
  processId: string;
  name: string;
  state: ProcessState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  nextCursor: string;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

export function parseCursor(cursor?: string): { stdout: number; stderr: number } {
  if (!cursor) return { stdout: 0, stderr: 0 };
  const [stdout, stderr] = cursor.split(":").map(Number);
  if (!Number.isInteger(stdout) || !Number.isInteger(stderr) || stdout < 0 || stderr < 0) {
    throw new Error("cursor is not a value returned by process_logs");
  }
  return { stdout, stderr };
}

export function formatCursor(stdout: number, stderr: number): string {
  return `${stdout}:${stderr}`;
}

/** Splits the read script output into its header and the two log chunks. */
export function parseProcessRead(output: string) {
  const [header = "", rest = ""] = splitOnce(output, "\n");
  const [stdoutSize, stderrSize, state, code] = header.trim().split(/\s+/);
  const [, afterOut = ""] = splitOnce(rest, "\0OUT\0");
  const [stdout, stderr] = splitOnce(afterOut, "\0ERR\0");
  return {
    stdoutSize: Number(stdoutSize) || 0,
    stderrSize: Number(stderrSize) || 0,
    state: state === "exited" ? ("exited" as const) : ("running" as const),
    exitCode: code === undefined || code === "-" ? null : Number(code),
    stdout,
    stderr: stderr ?? "",
  };
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private streamTimer: NodeJS.Timeout | null = null;

  async start(input: {
    chatId: string;
    repositoryPath: string;
    command: string;
    name?: string;
  }): Promise<{ processId: string; name: string }> {
    const running = this.forChat(input.chatId).filter((entry) => entry.state === "running");
    if (running.length >= config.SANDBOX_MAX_PROCESSES) {
      throw new Error(
        `This chat already has ${running.length} managed processes. Stop one before starting another.`,
      );
    }

    const id = randomUUID().slice(0, 12);
    const name = (input.name ?? input.command.split(/\s+/)[0] ?? "process").slice(0, 60);
    const directory = `${PROCESS_ROOT}/${id}`;

    await sandbox.detach(input.chatId, input.repositoryPath, START_SCRIPT, [directory, input.command]);
    this.processes.set(id, {
      id,
      chatId: input.chatId,
      repositoryPath: input.repositoryPath,
      name,
      command: input.command,
      directory,
      startedAt: Date.now(),
      state: "running",
      exitCode: null,
      streamedStdout: 0,
      streamedStderr: 0,
    });
    this.ensureStreaming();
    processLogger.info({ chatId: input.chatId, processId: id, name }, "Managed process started");
    return { processId: id, name };
  }

  async logs(input: {
    chatId: string;
    processId: string;
    cursor?: string;
    limit?: number;
  }): Promise<ProcessLogs> {
    const managed = this.require(input.chatId, input.processId);
    const cursor = parseCursor(input.cursor);
    const limit = Math.max(512, Math.min(input.limit ?? LOG_CHUNK_LIMIT, LOG_CHUNK_LIMIT));
    const read = await this.read(managed, cursor.stdout, cursor.stderr, limit);

    const nextStdout = cursor.stdout + Buffer.byteLength(read.stdout);
    const nextStderr = cursor.stderr + Buffer.byteLength(read.stderr);
    return {
      processId: managed.id,
      name: managed.name,
      state: managed.state,
      exitCode: managed.exitCode,
      stdout: read.stdout,
      stderr: read.stderr,
      nextCursor: formatCursor(nextStdout, nextStderr),
      truncated: nextStdout < read.stdoutSize || nextStderr < read.stderrSize,
      stdoutBytes: Buffer.byteLength(read.stdout),
      stderrBytes: Buffer.byteLength(read.stderr),
    };
  }

  async stop(input: { chatId: string; processId: string; force?: boolean }) {
    const managed = this.require(input.chatId, input.processId);
    if (managed.state !== "running") {
      return { processId: managed.id, name: managed.name, state: managed.state, exitCode: managed.exitCode };
    }

    const pid = await this.pidOf(managed);
    if (pid !== null) {
      await sandbox.killProcessTree(managed.chatId, managed.repositoryPath, pid, input.force ? "KILL" : "TERM");
      if (!input.force) {
        setTimeout(() => {
          void sandbox.killProcessTree(managed.chatId, managed.repositoryPath, pid, "KILL");
        }, 3_000).unref();
      }
    }
    managed.state = "stopped";
    processLogger.info(
      { chatId: managed.chatId, processId: managed.id, force: Boolean(input.force) },
      "Managed process stopped",
    );
    return { processId: managed.id, name: managed.name, state: managed.state, exitCode: managed.exitCode };
  }

  list(chatId: string) {
    return this.forChat(chatId).map((entry) => ({
      processId: entry.id,
      name: entry.name,
      state: entry.state,
      exitCode: entry.exitCode,
    }));
  }

  /** Container removal takes the processes with it, so the registry is dropped too. */
  forget(chatId: string): number {
    const owned = this.forChat(chatId);
    for (const entry of owned) this.processes.delete(entry.id);
    if (this.processes.size === 0 && this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    return owned.length;
  }

  async stopAll(chatId: string): Promise<number> {
    const running = this.forChat(chatId).filter((entry) => entry.state === "running");
    for (const entry of running) {
      await this.stop({ chatId, processId: entry.id, force: true }).catch(() => undefined);
    }
    return this.forget(chatId);
  }

  private forChat(chatId: string): ManagedProcess[] {
    return [...this.processes.values()].filter((entry) => entry.chatId === chatId);
  }

  private require(chatId: string, processId: string): ManagedProcess {
    const managed = this.processes.get(processId);
    if (!managed || managed.chatId !== chatId) throw new Error(`Unknown processId: ${processId}`);
    return managed;
  }

  private async read(managed: ManagedProcess, stdoutOffset: number, stderrOffset: number, limit: number) {
    const result = await sandbox.script(
      managed.chatId,
      managed.repositoryPath,
      READ_SCRIPT,
      [managed.directory, String(stdoutOffset), String(stderrOffset), String(limit)],
      { timeoutMs: 30_000, maxCapturedBytes: limit * 2 + 4_096 },
    );
    if (result.exitCode !== 0) throw new Error(`Process ${managed.id} logs are unavailable`);

    const parsed = parseProcessRead(result.stdout);
    if (managed.state === "running" && parsed.state === "exited") {
      managed.state = "exited";
      managed.exitCode = parsed.exitCode;
    }
    return parsed;
  }

  private async pidOf(managed: ManagedProcess): Promise<number | null> {
    const result = await sandbox
      .exec(managed.chatId, managed.repositoryPath, ["cat", "--", `${managed.directory}/pid`], { timeoutMs: 15_000 })
      .catch(() => null);
    const pid = Number(result?.stdout.trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }

  private ensureStreaming(): void {
    if (this.streamTimer) return;
    this.streamTimer = setInterval(() => void this.streamTick(), STREAM_INTERVAL_MS);
    this.streamTimer.unref();
  }

  private async streamTick(): Promise<void> {
    const running = [...this.processes.values()].filter((entry) => entry.state === "running");
    if (running.length === 0) {
      if (this.streamTimer) clearInterval(this.streamTimer);
      this.streamTimer = null;
      return;
    }

    for (const managed of running) {
      try {
        const read = await this.read(managed, managed.streamedStdout, managed.streamedStderr, STREAM_CHUNK_LIMIT);
        if (read.stdout) {
          managed.streamedStdout += Buffer.byteLength(read.stdout);
          publishTransient(managed.chatId, null, "process_output", {
            processId: managed.id,
            name: managed.name,
            stream: "stdout",
            chunk: read.stdout,
          });
        }
        if (read.stderr) {
          managed.streamedStderr += Buffer.byteLength(read.stderr);
          publishTransient(managed.chatId, null, "process_output", {
            processId: managed.id,
            name: managed.name,
            stream: "stderr",
            chunk: read.stderr,
          });
        }
        if (managed.state !== "running") {
          publishTransient(managed.chatId, null, "process_exited", {
            processId: managed.id,
            name: managed.name,
            exitCode: managed.exitCode,
          });
        }
      } catch (error) {
        processLogger.debug(
          { error: errorForLog(error), chatId: managed.chatId, processId: managed.id },
          "Managed process log streaming failed",
        );
      }
    }
  }
}

export const processManager = new ProcessManager();
