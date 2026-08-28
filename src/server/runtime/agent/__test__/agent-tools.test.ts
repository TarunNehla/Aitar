import { beforeEach, describe, expect, it, vi } from "vitest";

interface DockerCall {
  args: string[];
  options: Record<string, any>;
}

const dockerCalls: DockerCall[] = [];
const files = new Map<string, string>();
let directories = new Set<string>();

function blank(overrides: Record<string, unknown> = {}) {
  return { stdout: "", stderr: "", exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 1, ...overrides };
}

function respond(args: string[], options: Record<string, any>) {
  const script = args.find((argument) => argument.includes("$1")) ?? "";
  const positional = args.slice(args.indexOf(script) + 2);
  const path = positional[0] ?? "";

  if (script.includes("[ -d \"$1\" ]")) {
    if (directories.has(path)) return blank({ stdout: "directory" });
    if (files.has(path)) return blank({ stdout: "file" });
    return blank({ exitCode: 3 });
  }
  if (script.includes("printf 'd %s")) {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of [...files.keys(), ...directories]) {
      if (!key.startsWith(prefix)) continue;
      names.add(key.slice(prefix.length).split("/")[0] as string);
    }
    const entries = [...names].map((name) => `${directories.has(`${prefix}${name}`) ? "d" : "f"} ${name}\0`);
    return blank({ stdout: entries.join("") });
  }
  if (script.includes("find .")) {
    const prefix = `${path}/`;
    const listed = [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => `./${key.slice(prefix.length)}\0`);
    return blank({ stdout: listed.join("") });
  }
  if (script.includes("cat > \"$1\"")) {
    files.set(path, String(options.input ?? ""));
    return blank();
  }

  const command = args.slice(args.indexOf(args.find((argument) => argument.startsWith("cloud-agent-")) ?? "") + 1);
  if (command[0] === "cat") {
    const target = command[2] as string;
    const content = files.get(target);
    if (content === undefined) return blank({ exitCode: 1, stderr: `cat: ${target}: No such file or directory` });
    const buffer = Buffer.from(content);
    return blank({ stdout: content, stdoutBuffer: buffer, stdoutBytes: buffer.byteLength });
  }
  if (command[0] === "grep") {
    const target = command[command.length - 1] as string;
    const pattern = command[command.indexOf("-e") + 1] as string;
    const lines: string[] = [];
    for (const [key, content] of files) {
      if (!key.startsWith(target)) continue;
      content.split("\n").forEach((line, index) => {
        if (line.includes(pattern)) lines.push(`${key}\0${index + 1}:${line}`);
      });
    }
    return blank({ stdout: lines.join("\n"), exitCode: lines.length > 0 ? 0 : 1 });
  }
  if (command[0] === "mkdir") {
    directories.add(command[command.length - 1] as string);
    return blank();
  }
  return blank();
}

const runProcess = vi.fn(async (command: string, args: string[], options: Record<string, any> = {}) => {
  if (command !== "docker") throw new Error(`Only docker may run agent file work, got: ${command}`);
  dockerCalls.push({ args, options });
  if (args[0] === "inspect") return blank({ stdout: "true" });
  return respond(args, options);
});
const runChecked = vi.fn(async () => blank());

vi.mock("../../process.js", () => ({ runProcess, runChecked }));

const hostReads = vi.fn();
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: actual,
    readFile: (...input: unknown[]) => {
      hostReads(input[0]);
      return (actual.readFile as any)(...input);
    },
    writeFile: (...input: unknown[]) => {
      hostReads(input[0]);
      return (actual.writeFile as any)(...input);
    },
  };
});

const { createAgentTools } = await import("../agent-tools.js");
const { platformTimeoutSeconds } = await import("../../sandbox/sandbox-command.js");

const writer = {
  emit: vi.fn(async () => undefined),
  live: vi.fn(),
  liveDelta: vi.fn(),
  delta: vi.fn(),
  drain: vi.fn(async () => undefined),
};

function tools(chatId = "chat-1") {
  return createAgentTools({
    chatId,
    repositoryPath: "/tmp/cloud-agents-tests/repository",
    sessionId: "session-1",
    runId: "run-1",
    writer: writer as never,
    vision: {
      primaryModelId: "primary/model",
      supportsImages: () => false,
      wasDemoted: () => false,
      demoteToTextOnly: () => false,
      recordDirectDelivery: () => undefined,
      takeDirectDeliveries: () => [],
      inspect: async () => ({
        decision: "disabled" as const,
        text: "Visual analysis is turned off for this deployment.",
        structured: false,
        durationMs: 0,
      }),
    } as never,
  });
}

function tool(name: string, chatId = "chat-1") {
  const found = tools(chatId).find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>) {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** Container-side cleanup outlives the tool result, so cancellation assertions wait for it. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected Docker call");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  dockerCalls.length = 0;
  hostReads.mockClear();
  runProcess.mockClear();
  files.clear();
  directories = new Set(["/workspace", "/workspace/src"]);
  files.set("/workspace/src/index.ts", "const alpha = 1;\nconst beta = 2;\n");
  files.set("/workspace/README.md", "# Title\n");
  writer.live.mockClear();
  writer.liveDelta.mockClear();
  writer.emit.mockClear();
});

describe("agent tool schemas", () => {
  it("exposes exactly the standardized tool set", () => {
    expect(tools().map((entry) => entry.name)).toEqual([
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "bash",
      "start_process",
      "process_logs",
      "stop_process",
      "switch_base_branch",
      "create_pull_request",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_press",
      "browser_scroll",
      "browser_wait",
      "browser_screenshot",
      "inspect_image",
      "browser_console",
      "browser_close",
    ]);
  });

  it("has no removed tool and no network or permission input", () => {
    const removed = ["list_files", "read_file", "search_files", "write_file", "run_command", "git_diff", "finish", "git_push"];
    for (const name of removed) {
      expect(tools().some((entry) => entry.name === name), name).toBe(false);
    }
    for (const entry of tools()) {
      const properties = Object.keys((entry.parameters as any).properties ?? {});
      for (const forbidden of ["network", "cwd", "env", "environment", "mounts", "credentials", "token", "approve"]) {
        expect(properties, `${entry.name}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("matches the required schema for every tool", () => {
    const schemas = Object.fromEntries(
      tools().map((entry) => [entry.name, entry.parameters as any]),
    );
    const shape = (name: string) => ({
      properties: Object.keys(schemas[name].properties).sort(),
      required: [...(schemas[name].required ?? [])].sort(),
    });

    expect(shape("read")).toEqual({ properties: ["limit", "offset", "path"], required: ["path"] });
    expect(shape("edit")).toEqual({ properties: ["edits", "path"], required: ["edits", "path"] });
    expect(shape("write")).toEqual({ properties: ["content", "path"], required: ["content", "path"] });
    expect(shape("grep")).toEqual({
      properties: ["context", "glob", "ignoreCase", "limit", "literal", "path", "pattern"],
      required: ["pattern"],
    });
    expect(shape("find")).toEqual({ properties: ["limit", "path", "pattern"], required: ["pattern"] });
    expect(shape("ls")).toEqual({ properties: ["limit", "path"], required: [] });
    expect(shape("bash")).toEqual({ properties: ["command", "timeout"], required: ["command"] });
    expect(shape("start_process")).toEqual({ properties: ["command", "name"], required: ["command"] });
    expect(shape("process_logs")).toEqual({ properties: ["cursor", "limit", "processId"], required: ["processId"] });
    expect(shape("stop_process")).toEqual({ properties: ["force", "processId"], required: ["processId"] });
    expect(shape("switch_base_branch")).toEqual({ properties: ["branch"], required: ["branch"] });
    expect(shape("create_pull_request")).toEqual({
      properties: ["body", "branchName", "draft", "title"],
      required: ["branchName", "title"],
    });

    const edits = schemas.edit.properties.edits;
    expect(edits.type).toBe("array");
    expect(Object.keys(edits.items.properties).sort()).toEqual(["newText", "oldText"]);
  });
});

describe("file tools stay inside Docker", () => {
  it("reads through the container and never through host file APIs", async () => {
    const result = await tool("read").execute("call-1", { path: "src/index.ts" });

    expect(textOf(result)).toContain("const alpha = 1;");
    expect(result.details).toMatchObject({ path: "src/index.ts", lines: 3 });
    expect(dockerCalls.some((call) => call.args.includes("cat"))).toBe(true);
    expect(runProcess.mock.calls.every(([command]) => command === "docker")).toBe(true);
    expect(hostReads).not.toHaveBeenCalled();
  });

  it("writes and edits through the container", async () => {
    await tool("write").execute("call-2", { path: "src/new.ts", content: "export const value = 1;\n" });
    expect(files.get("/workspace/src/new.ts")).toBe("export const value = 1;\n");
    expect(writer.live).toHaveBeenCalledWith("file_changed", expect.objectContaining({ path: "src/new.ts" }));

    await tool("edit").execute("call-3", {
      path: "src/index.ts",
      edits: [{ oldText: "const alpha = 1;", newText: "const alpha = 42;" }],
    });
    expect(files.get("/workspace/src/index.ts")).toContain("const alpha = 42;");
    expect(hostReads).not.toHaveBeenCalled();
  });

  it("lists, finds, and greps through the container", async () => {
    const listed = await tool("ls").execute("call-4", { path: "." });
    expect(textOf(listed)).toContain("src/");
    expect(listed.details).toMatchObject({ path: "." });

    const found = await tool("find").execute("call-5", { pattern: "*.ts" });
    expect(textOf(found)).toContain("src/index.ts");

    const matched = await tool("grep").execute("call-6", { pattern: "beta" });
    expect(textOf(matched)).toContain("src/index.ts:2");
    expect(matched.details).toMatchObject({ matches: 1, files: 1 });
    expect(runProcess.mock.calls.every(([command]) => command === "docker")).toBe(true);
  });

  it("refuses paths that leave the workspace before touching Docker", async () => {
    for (const path of ["../../etc/passwd", "/etc/passwd", "~/.ssh/id_rsa"]) {
      dockerCalls.length = 0;
      await expect(tool("read").execute("call-7", { path }), path).rejects.toThrow();
      expect(dockerCalls.some((call) => JSON.stringify(call.args).includes("/etc/passwd")), path).toBe(false);
    }
  });

  it("keeps every container path under the workspace mount", async () => {
    await tool("ls").execute("call-8", { path: "src" });
    await tool("read").execute("call-9", { path: "README.md" });
    for (const call of dockerCalls) {
      for (const argument of call.args) {
        if (argument.startsWith("/") && !argument.startsWith("/workspace") && !argument.startsWith("/tmp/cloud-agent")) {
          throw new Error(`Docker argument escaped the workspace: ${argument}`);
        }
      }
    }
  });
});

describe("bash tool", () => {
  it("runs from /workspace inside the chat container", async () => {
    runProcess.mockImplementationOnce(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      return blank({ stdout: "ok" });
    });
    runProcess.mockImplementationOnce(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      options.onStdout?.("ok\n");
      return blank({ stdout: "ok\n" });
    });

    const result = await tool("bash").execute("call-10", { command: "pnpm test" });
    const call = dockerCalls.find((entry) => entry.args.some((argument) => argument.includes("cd /workspace")));
    expect(call?.args[0]).toBe("exec");
    expect(call?.args).toContain("pnpm test");
    expect(result.details).toMatchObject({ exitCode: 0, command: "pnpm test" });
  });

  it("streams stdout and stderr separately", async () => {
    runProcess.mockImplementation(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      if (args[0] === "inspect") return blank({ stdout: "true" });
      options.onStdout?.("first line\n");
      options.onStderr?.("a warning\n");
      options.onStdout?.("second line\n");
      return blank();
    });

    const result = await tool("bash").execute("call-11", { command: "build" });

    const streams = writer.liveDelta.mock.calls.map(([type, , chunk]) => [type, chunk]);
    expect(streams).toContainEqual(["stdout_chunk", "first line\n"]);
    expect(streams).toContainEqual(["stderr_chunk", "a warning\n"]);
    expect(result.details).toMatchObject({ stdoutBytes: 23, stderrBytes: 10 });
    expect(textOf(result)).toBe("first line\na warning\nsecond line\n");
  });

  it("kills the whole process tree when cancelled", async () => {
    const controller = new AbortController();
    runProcess.mockImplementation(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      if (args[0] === "inspect") return blank({ stdout: "true" });
      const script = args.find((argument) => argument.includes("$1")) ?? "";
      if (script.includes("cd /workspace")) {
        return new Promise((resolve) => {
          options.signal?.addEventListener?.("abort", () => resolve(blank({ exitCode: 143 })));
          setTimeout(() => controller.abort(), 5);
        });
      }
      if (args.includes("cat")) return blank({ stdout: "4242" });
      if (args.some((argument) => argument.includes("/proc/[0-9]*"))) {
        return blank({ stdout: "4242 1\n4300 4242\n4301 4300\n" });
      }
      return blank();
    });

    await expect(
      tool("bash").execute("call-12", { command: "sleep 600" }, controller.signal),
    ).rejects.toThrow("Command cancelled");

    const kill = await waitFor(() => dockerCalls.find((entry) => entry.args.includes("kill")));
    expect(kill.args).toContain("-TERM");
    expect(kill.args).toEqual(expect.arrayContaining(["4242", "4300", "4301"]));
  }, 10_000);

  it("caps the model timeout at the platform maximum", async () => {
    runProcess.mockImplementation(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      return args[0] === "inspect" ? blank({ stdout: "true" }) : blank();
    });

    await tool("bash").execute("call-13", { command: "echo hi", timeout: 99_999 });

    const call = dockerCalls.find((entry) => entry.args.some((argument) => argument.includes("cd /workspace")));
    expect(call?.options.timeoutMs).toBe((platformTimeoutSeconds() + 30) * 1_000);
    expect(tool("bash").description).toContain(String(platformTimeoutSeconds()));
  });

  it("stops a command that outlives its timeout and reports no exit code", async () => {
    let timedOutPid: string | null = null;
    runProcess.mockImplementation(async (_command, args, options: any) => {
      dockerCalls.push({ args, options });
      if (args[0] === "inspect") return blank({ stdout: "true" });
      const script = args.find((argument) => argument.includes("$1")) ?? "";
      if (script.includes("cd /workspace")) {
        return new Promise((resolve) => {
          const finish = () => resolve(blank({ exitCode: 143 }));
          options.signal?.addEventListener?.("abort", finish);
          const poll = setInterval(() => {
            if (timedOutPid) {
              clearInterval(poll);
              finish();
            }
          }, 10);
          poll.unref?.();
        });
      }
      if (args.includes("cat")) return blank({ stdout: "77" });
      if (args.some((argument) => argument.includes("/proc/[0-9]*"))) return blank({ stdout: "77 1\n" });
      if (args.includes("kill")) {
        timedOutPid = "77";
        return blank();
      }
      return blank();
    });

    const failure = await tool("bash")
      .execute("call-14", { command: "sleep 30", timeout: 1 })
      .then(() => null, (error: Error) => error);

    expect(failure?.message).toContain("timed out after 1 seconds");
    expect(timedOutPid).toBe("77");
  }, 10_000);
});
