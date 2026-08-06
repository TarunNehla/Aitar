import { beforeEach, describe, expect, it, vi } from "vitest";

const runProcess = vi.fn(async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  durationMs: 1,
}));
const runChecked = vi.fn(async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  durationMs: 1,
}));

vi.mock("./process.js", () => ({ runProcess, runChecked }));

const { withInstallationCredentials } = await import("./git-credentials.js");
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
];

beforeEach(() => {
  runProcess.mockClear();
  runChecked.mockClear();
});

describe("sandbox isolation", () => {
  it("never passes credential material into Docker", async () => {
    await withInstallationCredentials(token, async () => {
      await workspaceManager.execute("chat-1", "/tmp/cloud-agents-tests/repository", "echo hi", { network: true });
    });

    expect(runProcess).toHaveBeenCalled();
    for (const call of runProcess.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>) {
      const [command, commandArguments, options] = call;
      expect(command).toBe("docker");
      expect(JSON.stringify(commandArguments)).not.toContain(token);
      for (const name of secretEnvironmentNames) {
        expect(commandArguments).not.toContain(name);
        expect(commandArguments.some((argument) => argument.includes(`${name}=`))).toBe(false);
      }
      expect(commandArguments).not.toContain("-e");
      expect(commandArguments).not.toContain("--env");
      expect(options?.env).toBeUndefined();
    }
  });

  it("does not forward credentials to the long-lived sandbox container", async () => {
    runProcess.mockResolvedValueOnce({
      stdout: "false",
      stderr: "",
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 1,
    });

    await withInstallationCredentials(token, async () => {
      await workspaceManager.ensureSandbox("chat-2", "/tmp/cloud-agents-tests/repository");
    });

    for (const call of runChecked.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>) {
      const [, commandArguments, options] = call;
      expect(JSON.stringify(commandArguments)).not.toContain(token);
      expect(JSON.stringify(options?.env ?? {})).not.toContain(token);
    }
  });

  it("passes credentials only to host Git fetches", async () => {
    await withInstallationCredentials(token, async (gitEnvironment) => {
      await workspaceManager.prepareRepository({
        repositoryId: "repository-1",
        repositoryUrl: "https://github.com/acme/service.git",
        baseBranch: "main",
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
});
