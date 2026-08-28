import { beforeEach, describe, expect, it, vi } from "vitest";

interface DockerCall {
  args: string[];
  options: Record<string, any>;
}

const dockerCalls: DockerCall[] = [];
const logs = new Map<string, { stdout: string; stderr: string; exit: string | null; pid: string }>();

function blank(overrides: Record<string, unknown> = {}) {
  return { stdout: "", stderr: "", exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 1, ...overrides };
}

function directoryOf(args: string[]): string {
  return args.find((argument) => argument.includes("/tmp/cloud-agent/processes/")) ?? "";
}

const runProcess = vi.fn(async (command: string, args: string[], options: Record<string, any> = {}) => {
  dockerCalls.push({ args, options });
  if (args[0] === "inspect") return blank({ stdout: "true" });

  const directory = directoryOf(args);
  const entry = logs.get(directory.replace(/\/pid$/, ""));
  if (args.includes("cat") && directory.endsWith("/pid")) return blank({ stdout: entry?.pid ?? "" });

  const script = args.find((argument) => argument.includes("$directory")) ?? "";
  if (script && entry) {
    const stdoutOffset = Number(args[args.indexOf(directory) + 1]);
    const stderrOffset = Number(args[args.indexOf(directory) + 2]);
    const header = [
      Buffer.byteLength(entry.stdout),
      Buffer.byteLength(entry.stderr),
      entry.exit === null ? "running" : "exited",
      entry.exit ?? "-",
    ].join(" ");
    return blank({
      stdout: `${header}\n\0OUT\0${entry.stdout.slice(stdoutOffset)}\0ERR\0${entry.stderr.slice(stderrOffset)}`,
    });
  }
  if (args.some((argument) => argument.includes("/proc/[0-9]*"))) return blank({ stdout: `${entry?.pid ?? 9} 1\n` });
  return blank();
});
const runChecked = vi.fn(async (command: string, args: string[]) => {
  dockerCalls.push({ args, options: {} });
  const directory = directoryOf(args);
  if (directory) logs.set(directory, { stdout: "", stderr: "", exit: null, pid: "5150" });
  return blank();
});

vi.mock("../../process.js", () => ({ runProcess, runChecked }));

const { processManager, parseCursor, formatCursor, parseProcessRead } = await import("../sandbox-processes.js");
const { processTreePids, parseProcessTable } = await import("../sandbox.js");

const repositoryPath = "/tmp/cloud-agents-tests/repository";

beforeEach(() => {
  dockerCalls.length = 0;
  logs.clear();
});

describe("process cursors", () => {
  it("round-trips a cursor and rejects anything else", () => {
    expect(parseCursor(undefined)).toEqual({ stdout: 0, stderr: 0 });
    expect(parseCursor(formatCursor(12, 34))).toEqual({ stdout: 12, stderr: 34 });
    expect(() => parseCursor("nonsense")).toThrow("process_logs");
    expect(() => parseCursor("-1:0")).toThrow("process_logs");
  });

  it("splits the read script output into a header and two streams", () => {
    const parsed = parseProcessRead("10 4 exited 2\n\0OUT\0hello\0ERR\0oops");
    expect(parsed).toMatchObject({ stdoutSize: 10, stderrSize: 4, state: "exited", exitCode: 2 });
    expect(parsed.stdout).toBe("hello");
    expect(parsed.stderr).toBe("oops");
  });
});

describe("process tree resolution", () => {
  it("collects every descendant and never reaches init", () => {
    const table = parseProcessTable("1 0\n10 1\n11 10\n12 11\n20 1\n");
    expect(processTreePids(table, 10).sort()).toEqual([10, 11, 12]);
    expect(processTreePids(table, 20)).toEqual([20]);
    expect(processTreePids(table, 1)).toEqual([]);
  });
});

describe("managed processes", () => {
  it("runs inside the chat container and returns a chat-scoped id", async () => {
    const started = await processManager.start({
      chatId: "chat-a",
      repositoryPath,
      command: "pnpm dev",
      name: "dev-server",
    });

    expect(started.name).toBe("dev-server");
    const detach = dockerCalls.find((call) => call.args.includes("-d"));
    expect(detach?.args[0]).toBe("exec");
    expect(detach?.args).toContain("cloud-agent-chat-a");
    expect(JSON.stringify(detach?.args)).toContain("cd /workspace");
    expect(JSON.stringify(detach?.args)).toContain(`/tmp/cloud-agent/processes/${started.processId}`);

    await processManager.stopAll("chat-a");
  });

  it("keeps process ids isolated between chats", async () => {
    const first = await processManager.start({ chatId: "chat-a", repositoryPath, command: "pnpm dev" });
    const second = await processManager.start({ chatId: "chat-b", repositoryPath, command: "pnpm dev" });

    expect(first.processId).not.toBe(second.processId);
    expect(processManager.list("chat-a").map((entry) => entry.processId)).toEqual([first.processId]);
    expect(processManager.list("chat-b").map((entry) => entry.processId)).toEqual([second.processId]);

    for (const call of [
      () => processManager.logs({ chatId: "chat-b", processId: first.processId }),
      () => processManager.stop({ chatId: "chat-b", processId: first.processId }),
    ]) {
      await expect(call()).rejects.toThrow(`Unknown processId: ${first.processId}`);
    }

    await processManager.stopAll("chat-a");
    await processManager.stopAll("chat-b");
  });

  it("returns new output, status, and the next cursor", async () => {
    const started = await processManager.start({ chatId: "chat-a", repositoryPath, command: "pnpm dev" });
    const directory = `/tmp/cloud-agent/processes/${started.processId}`;
    logs.set(directory, { stdout: "ready on 3000\n", stderr: "warn\n", exit: null, pid: "5150" });

    const first = await processManager.logs({ chatId: "chat-a", processId: started.processId });
    expect(first.stdout).toBe("ready on 3000\n");
    expect(first.stderr).toBe("warn\n");
    expect(first.state).toBe("running");
    expect(first.nextCursor).toBe(formatCursor(14, 5));
    expect(first.truncated).toBe(false);

    logs.set(directory, { stdout: "ready on 3000\ncompiled\n", stderr: "warn\n", exit: "0", pid: "5150" });
    const second = await processManager.logs({
      chatId: "chat-a",
      processId: started.processId,
      cursor: first.nextCursor,
    });
    expect(second.stdout).toBe("compiled\n");
    expect(second.stderr).toBe("");
    expect(second.state).toBe("exited");
    expect(second.exitCode).toBe(0);

    await processManager.stopAll("chat-a");
  });

  it("terminates the process tree on stop and forgets processes with the container", async () => {
    const started = await processManager.start({ chatId: "chat-a", repositoryPath, command: "pnpm dev" });
    logs.set(`/tmp/cloud-agent/processes/${started.processId}`, {
      stdout: "",
      stderr: "",
      exit: null,
      pid: "5150",
    });

    const stopped = await processManager.stop({ chatId: "chat-a", processId: started.processId, force: true });
    expect(stopped.state).toBe("stopped");
    const kill = dockerCalls.find((call) => call.args.includes("kill"));
    expect(kill?.args).toContain("-KILL");
    expect(kill?.args).toContain("5150");

    expect(processManager.forget("chat-a")).toBe(1);
    expect(processManager.list("chat-a")).toEqual([]);
    await expect(processManager.logs({ chatId: "chat-a", processId: started.processId }))
      .rejects.toThrow("Unknown processId");
  });
});
