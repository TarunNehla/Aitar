import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    input?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxCapturedBytes = 512 * 1024;

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
      finish(() => reject(new Error(`Command timed out after ${options.timeoutMs} ms`)));
    }, options.timeoutMs ?? 120_000);
    timer.unref();

    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout!.on("data", (buffer: Buffer) => {
      const chunk = buffer.toString();
      if (stdout.length < maxCapturedBytes) stdout += chunk;
      options.onStdout?.(chunk);
    });

    child.stderr!.on("data", (buffer: Buffer) => {
      const chunk = buffer.toString();
      if (stderr.length < maxCapturedBytes) stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
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
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} exited with ${result.exitCode}`);
  }
  return result;
}
