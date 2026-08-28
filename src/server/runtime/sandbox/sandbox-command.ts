import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { sandbox, SANDBOX_STATE_PATH, WORKSPACE_PATH } from "./sandbox.js";

const commandLogger = logger.child({ component: "sandbox-command" });

const OUTPUT_TAIL_LIMIT = 60_000;
const TERMINATION_GRACE_MS = 3_000;

const COMMAND_SCRIPT = `mkdir -p -- "$(dirname -- "$1")"
printf '%s' "$$" > "$1"
cd ${WORKSPACE_PATH} || exit 1
exec sh -lc "$2"`;

export type CommandStatus = "completed" | "aborted" | "timeout";

export interface CommandOutcome {
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  status: CommandStatus;
  text: string;
}

export function platformTimeoutSeconds(): number {
  return config.SANDBOX_TIMEOUT_SECONDS;
}

/** Clamps a model-supplied timeout to the platform maximum. */
export function effectiveTimeoutSeconds(requested?: number): number {
  const maximum = platformTimeoutSeconds();
  if (requested === undefined) return maximum;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("timeout must be a positive number of seconds");
  return Math.min(Math.ceil(requested), maximum);
}

export async function runSandboxCommand(input: {
  chatId: string;
  repositoryPath: string;
  command: string;
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<CommandOutcome> {
  const startedAt = Date.now();
  const timeoutSeconds = effectiveTimeoutSeconds(input.timeout);
  const pidPath = `${SANDBOX_STATE_PATH}/commands/${randomUUID()}.pid`;

  let combined = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let status: CommandStatus = "completed";
  let terminated = false;

  const append = (chunk: string) => {
    combined += chunk;
    if (combined.length > OUTPUT_TAIL_LIMIT * 2) combined = combined.slice(-OUTPUT_TAIL_LIMIT * 2);
  };

  const terminate = async (reason: CommandStatus) => {
    if (terminated) return;
    terminated = true;
    status = reason;
    const pid = await readPid(input.chatId, input.repositoryPath, pidPath);
    if (pid === null) return;
    await sandbox.killProcessTree(input.chatId, input.repositoryPath, pid, "TERM");
    setTimeout(() => {
      void sandbox.killProcessTree(input.chatId, input.repositoryPath, pid, "KILL");
    }, TERMINATION_GRACE_MS).unref();
  };

  const onAbort = () => void terminate("aborted");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => void terminate("timeout"), timeoutSeconds * 1_000);
  timer.unref();

  try {
    if (input.signal?.aborted) throw new Error("The command was cancelled");

    const result = await sandbox.script(
      input.chatId,
      input.repositoryPath,
      COMMAND_SCRIPT,
      [pidPath, input.command],
      {
        // The container-side tree kill runs first; this only stops the docker client waiting on it.
        signal: input.signal,
        timeoutMs: (timeoutSeconds + 30) * 1_000,
        captureTail: true,
        onStdout: (chunk) => {
          stdoutBytes += Buffer.byteLength(chunk);
          append(chunk);
          input.onStdout?.(chunk);
        },
        onStderr: (chunk) => {
          stderrBytes += Buffer.byteLength(chunk);
          append(chunk);
          input.onStderr?.(chunk);
        },
      },
    );

    const truncation = truncateTail(combined, { maxBytes: OUTPUT_TAIL_LIMIT });
    const outcome: CommandOutcome = {
      exitCode: terminated ? null : result.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutBytes,
      stderrBytes,
      truncated: truncation.truncated,
      status,
      text: truncation.content,
    };

    commandLogger.info(
      {
        chatId: input.chatId,
        exitCode: outcome.exitCode,
        status: outcome.status,
        durationMs: outcome.durationMs,
        stdoutBytes,
        stderrBytes,
      },
      "Sandbox command finished",
    );
    return outcome;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    void sandbox
      .exec(input.chatId, input.repositoryPath, ["rm", "-f", "--", pidPath], { timeoutMs: 15_000 })
      .catch(() => undefined);
  }
}

async function readPid(chatId: string, repositoryPath: string, pidPath: string): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await sandbox
      .exec(chatId, repositoryPath, ["cat", "--", pidPath], { timeoutMs: 15_000 })
      .catch(() => null);
    const pid = Number(result?.stdout.trim());
    if (Number.isInteger(pid) && pid > 1) return pid;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}
