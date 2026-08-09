import { spawn } from "node:child_process";
import { errorForLog, logger } from "../logger.js";

const processLogger = logger.child({ component: "process" });

export interface ProcessResult {
  stdout: string;
  stderr: string;
  stdoutBuffer?: Buffer;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    input?: string | Buffer;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    captureTail?: boolean;
    binary?: boolean;
    maxCapturedBytes?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 120_000;
    processLogger.debug({ executable: command, timeoutMs }, "Process started");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const binaryChunks: Buffer[] = [];
    let binaryBytes = 0;
    const maxCapturedBytes = options.maxCapturedBytes ?? 512 * 1024;
    const capture = (current: string, chunk: string) => {
      if (!options.captureTail) return current.length < maxCapturedBytes ? current + chunk : current;
      const combined = current + chunk;
      return combined.length > maxCapturedBytes ? combined.slice(-maxCapturedBytes) : combined;
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };

    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };

    const timer = setTimeout(() => {
      abort();
      finish(() => {
        processLogger.warn(
          { executable: command, durationMs: Date.now() - startedAt },
          "Process timed out",
        );
        reject(new Error(`Command timed out after ${timeoutMs} ms`));
      });
    }, timeoutMs);
    timer.unref();

    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout!.on("data", (buffer: Buffer) => {
      stdoutBytes += buffer.length;
      if (options.binary) {
        if (binaryBytes < maxCapturedBytes) {
          binaryChunks.push(buffer);
          binaryBytes += buffer.length;
        }
      } else {
        const chunk = buffer.toString();
        stdout = capture(stdout, chunk);
        options.onStdout?.(chunk);
      }
    });

    child.stderr!.on("data", (buffer: Buffer) => {
      const chunk = buffer.toString();
      stderrBytes += buffer.length;
      stderr = capture(stderr, chunk);
      options.onStderr?.(chunk);
    });

    child.on("error", (error) =>
      finish(() => {
        processLogger.error(
          { error: errorForLog(error), executable: command, durationMs: Date.now() - startedAt },
          "Process failed to start",
        );
        reject(error);
      }),
    );
    child.on("close", (code) => {
      finish(() => {
        const exitCode = code ?? 1;
        const durationMs = Date.now() - startedAt;
        const data = {
          executable: command,
          exitCode,
          durationMs,
          stdoutBytes,
          stderrBytes,
        };
        if (exitCode === 0) processLogger.debug(data, "Process completed");
        else processLogger.debug(data, "Process exited with a non-zero status");
        resolve({
          stdout,
          stderr,
          exitCode,
          stdoutBytes,
          stderrBytes,
          durationMs,
          ...(options.binary ? { stdoutBuffer: Buffer.concat(binaryChunks) } : {}),
        });
      });
    });

    if (options.input !== undefined) {
      child.stdin!.end(options.input);
    }
  });
}

export async function runChecked(
  command: string,
  args: string[],
  options: Parameters<typeof runProcess>[2] = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    processLogger.warn({ executable: command, exitCode: result.exitCode }, "Checked process failed");
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited with ${result.exitCode}`);
  }
  return result;
}
