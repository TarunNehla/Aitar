import { beforeEach, describe, expect, it, vi } from "vitest";

const result = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  durationMs: 1,
};

const runProcess = vi.fn(async () => ({ ...result }));
const runChecked = vi.fn(async () => ({ ...result }));

vi.mock("./process.js", () => ({ runProcess, runChecked }));

const { withInstallationCredentials } = await import("./git-credentials.js");
const { sandbox, containerName, resolveWorkspacePath, WORKSPACE_PATH } = await import("./sandbox.js");
const { workspaceManager } = await import("./workspace-manager.js");

const token = "ghs_sandboxisolationtesttoken00000000";
const secretEnvironmentNames = [
  "GIT_CREDENTIAL_TOKEN",
  "GIT_CREDENTIAL_USERNAME",
  "GIT_ASKPASS",
  "BETTER_AUTH_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "OPENROUTER_API_KEY",
  "DATABASE_URL",
];

function dockerCalls() {
  return [...runProcess.mock.calls, ...runChecked.mock.calls] as unknown as Array<
    [string, string[], Record<string, unknown>?]
  >;
}

beforeEach(() => {
  runProcess.mockClear();
  runChecked.mockClear();
  runProcess.mockImplementation(async () => ({ ...result }));
});

describe("workspace path containment", () => {
  it("keeps every agent path inside the workspace mount", () => {
    expect(resolveWorkspacePath("src/index.ts")).toBe(`${WORKSPACE_PATH}/src/index.ts`);
    expect(resolveWorkspacePath("./nested/../src/index.ts")).toBe(`${WORKSPACE_PATH}/src/index.ts`);
    expect(resolveWorkspacePath(`${WORKSPACE_PATH}/src`)).toBe(`${WORKSPACE_PATH}/src`);
    expect(resolveWorkspacePath("")).toBe(WORKSPACE_PATH);
  });

  it("rejects traversal, absolute host paths, and null bytes", () => {
    for (const path of ["../secret", "../../etc/passwd", "/etc/passwd", "/Users/someone/.ssh/id_rsa"]) {
      expect(() => resolveWorkspacePath(path), path).toThrow("must stay inside /workspace");
    }
    expect(() => resolveWorkspacePath("src/\0")).toThrow("Invalid path");
  });
});

describe("sandbox isolation", () => {
  it("starts containers without a Docker socket, extra mounts, privileges, or root", async () => {
    runProcess.mockResolvedValueOnce({ ...result, exitCode: 1 });

    await sandbox.ensureContainer("chat-isolation", "/tmp/cloud-agents-tests/repository");

    const run = dockerCalls().find(([, args]) => args[0] === "run");
    expect(run?.[0]).toBe("docker");
    const args = run?.[1] ?? [];
    const mounts = args.filter((argument, index) => args[index - 1] === "--mount");
    expect(mounts).toEqual([`type=bind,src=/tmp/cloud-agents-tests/repository,dst=${WORKSPACE_PATH}`]);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("-v");
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("--security-opt");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges:true");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("--memory");
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--user") + 1]).not.toMatch(/^0:/);
    expect(JSON.stringify(args)).not.toContain("docker.sock");
  });

  it("gives containers outbound internet by default", async () => {
    runProcess.mockResolvedValueOnce({ ...result, exitCode: 1 });

    await sandbox.ensureContainer("chat-network", "/tmp/cloud-agents-tests/repository");

    const run = dockerCalls().find(([, args]) => args[0] === "run");
    expect(run?.[1]).not.toContain("--network");
    expect(JSON.stringify(run?.[1])).not.toContain("none");
  });

  it("never passes credential material into Docker", async () => {
    await withInstallationCredentials(token, async () => {
      await sandbox.script("chat-1", "/tmp/cloud-agents-tests/repository", "echo hi");
    });

    expect(runProcess).toHaveBeenCalled();
    for (const [command, commandArguments, options] of dockerCalls()) {
      expect(command).toBe("docker");
      expect(JSON.stringify(commandArguments)).not.toContain(token);
      for (const name of secretEnvironmentNames) {
        expect(commandArguments).not.toContain(name);
        expect(commandArguments.some((argument) => argument.includes(`${name}=`))).toBe(false);
      }
      expect(options?.env).toBeUndefined();
    }
  });

  it("does not forward credentials to the long-lived chat container", async () => {
    runProcess.mockResolvedValueOnce({ ...result, exitCode: 1 });

    await withInstallationCredentials(token, async () => {
      await sandbox.ensureContainer("chat-2", "/tmp/cloud-agents-tests/repository");
    });

    for (const [, commandArguments, options] of dockerCalls()) {
      expect(JSON.stringify(commandArguments)).not.toContain(token);
      expect(JSON.stringify(options?.env ?? {})).not.toContain(token);
    }
  });

  it("passes credentials only to host Git fetches", async () => {
    await withInstallationCredentials(token, async (gitEnvironment) => {
      await workspaceManager.prepareRepository({
        repositoryId: "repository-1",
        repositoryUrl: "https://github.com/acme/service.git",
        defaultBranch: "main",
        gitEnvironment,
      });
    });

    const gitCalls = runChecked.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>;
    const fetchCall = gitCalls.find(([, commandArguments]) => commandArguments.includes("fetch"));
    const remoteCall = gitCalls.find(([, commandArguments]) => commandArguments.includes("set-url"));

    expect(fetchCall?.[0]).toBe("git");
    expect((fetchCall?.[2]?.env as NodeJS.ProcessEnv).GIT_CREDENTIAL_TOKEN).toBe(token);
    expect(JSON.stringify(fetchCall?.[1])).not.toContain(token);
    expect(JSON.stringify(remoteCall?.[1])).not.toContain(token);
    expect((remoteCall?.[2]?.env as NodeJS.ProcessEnv).GIT_CREDENTIAL_TOKEN).toBe("");
  });

  it("scopes containers to one chat", () => {
    expect(containerName("chat-a")).toBe("cloud-agent-chat-a");
    expect(containerName("chat-b")).not.toBe(containerName("chat-a"));
  });
});
