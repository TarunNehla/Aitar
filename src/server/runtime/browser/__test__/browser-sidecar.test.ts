import { beforeEach, describe, expect, it, vi } from "vitest";

const result = { stdout: "", stderr: "", exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };

async function dockerDefaults(_command: string, args: string[]) {
  if (args[0] === "port") return { ...result, stdout: "127.0.0.1:49160\n" };
  if (args[0] === "network" && args[1] === "inspect") return { ...result, exitCode: 1 };
  return { ...result };
}

const runProcess = vi.fn(dockerDefaults);
const runChecked = vi.fn(async (_command: string, args: string[]) => {
  if (args[0] === "port") return { ...result, stdout: "127.0.0.1:49160\n" };
  return { ...result };
});

vi.mock("../../process.js", () => ({ runProcess, runChecked }));

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ready: true }), { status: 200 }));
vi.stubGlobal("fetch", fetchMock);

const { BrowserSidecar, browserContainerName, browserNetworkName, browserIsolationArguments } = await import(
  "../browser-sidecar.js"
);

function dockerCalls() {
  return [...runProcess.mock.calls, ...runChecked.mock.calls] as unknown as Array<[string, string[]]>;
}

function runArguments() {
  return dockerCalls().find(([, args]) => args[0] === "run")?.[1] ?? [];
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

beforeEach(() => {
  runProcess.mockReset();
  runProcess.mockImplementation(dockerDefaults);
  runChecked.mockClear();
  fetchMock.mockClear();
});

describe("browser sidecar isolation", () => {
  it("gives the sidecar no repository mount, no host mount, and no Docker socket", async () => {
    await new BrowserSidecar().ensure("chat-isolation");
    const args = runArguments();
    const serialised = JSON.stringify(args);

    expect(args).not.toContain("--mount");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
    expect(serialised).not.toContain("docker.sock");
    expect(serialised).not.toContain("/workspace");
  });

  it("runs as a non-root user with no capabilities and no new privileges", () => {
    const args = browserIsolationArguments();
    expect(flagValue(args, "--user")).toBe("10001:10001");
    expect(flagValue(args, "--cap-drop")).toBe("ALL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).not.toContain("--privileged");
    expect(JSON.stringify(args)).not.toContain("SYS_ADMIN");
  });

  it("keeps the Chromium sandbox available through a seccomp profile", () => {
    const args = browserIsolationArguments();
    const seccomp = args.find((entry) => entry.startsWith("seccomp="));
    expect(seccomp).toBeDefined();
    expect(seccomp).toContain("docker/browser/seccomp.json");
    expect(args).not.toContain("seccomp=unconfined");
  });

  it("uses a read-only root filesystem with writable temporary locations", () => {
    const args = browserIsolationArguments();
    expect(args).toContain("--read-only");
    const tmpfs = args.filter((entry) => entry.startsWith("/tmp:") || entry.startsWith("/home/pw:"));
    expect(tmpfs).toHaveLength(2);
    expect(args).toContain("--init");
    expect(flagValue(args, "--ipc")).toBe("private");
  });

  it("applies its own memory, CPU, and process limits", () => {
    const args = browserIsolationArguments();
    expect(flagValue(args, "--memory")).toBe("1024m");
    expect(flagValue(args, "--memory-swap")).toBe("1024m");
    expect(flagValue(args, "--cpus")).toBe("0.5");
    expect(flagValue(args, "--pids-limit")).toBe("256");
  });

  it("never passes application credentials to the sidecar", async () => {
    await new BrowserSidecar().ensure("chat-credentials");
    const serialised = JSON.stringify(runArguments());
    for (const secret of ["DATABASE_URL", "OPENROUTER", "GITHUB", "BETTER_AUTH", "postgres://", "ghp_"]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });

  it("keeps the controller off the public network and off host networking", async () => {
    await new BrowserSidecar().ensure("chat-network");
    const args = runArguments();
    expect(flagValue(args, "--publish")).toBe("127.0.0.1::4000");
    expect(flagValue(args, "--network")).toBe(browserNetworkName("chat-network"));
    expect(args).not.toContain("host");
    expect(JSON.stringify(args)).not.toContain("0.0.0.0::");
  });
});

describe("browser sidecar lifecycle", () => {
  it("creates a private network and attaches the chat container under a stable alias", async () => {
    await new BrowserSidecar().ensure("chat-alias");
    const created = dockerCalls().find(([, args]) => args[0] === "network" && args[1] === "create");
    expect(created?.[1]).toContain(browserNetworkName("chat-alias"));

    const connected = dockerCalls().find(([, args]) => args[0] === "network" && args[1] === "connect");
    expect(connected?.[1]).toEqual([
      "network",
      "connect",
      "--alias",
      "workspace",
      browserNetworkName("chat-alias"),
      "cloud-agent-chat-alias",
    ]);
  });

  it("starts one sidecar for concurrent calls in the same chat", async () => {
    const sidecar = new BrowserSidecar();
    const [first, second, third] = await Promise.all([
      sidecar.ensure("chat-duplicate"),
      sidecar.ensure("chat-duplicate"),
      sidecar.ensure("chat-duplicate"),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(dockerCalls().filter(([, args]) => args[0] === "run")).toHaveLength(1);
  });

  it("reuses the running sidecar instead of starting a second one", async () => {
    const sidecar = new BrowserSidecar();
    await sidecar.ensure("chat-reuse");
    runChecked.mockClear();
    await sidecar.ensure("chat-reuse");
    expect(runChecked.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(0);
  });

  it("gives every chat its own container, network, and controller token", async () => {
    const sidecar = new BrowserSidecar();
    const first = await sidecar.ensure("chat-a");
    const second = await sidecar.ensure("chat-b");

    expect(first.container).toBe(browserContainerName("chat-a"));
    expect(second.container).toBe(browserContainerName("chat-b"));
    expect(first.network).not.toBe(second.network);
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("removes the container before the network so the network is free", async () => {
    const sidecar = new BrowserSidecar();
    await sidecar.ensure("chat-teardown");
    runProcess.mockClear();
    await sidecar.remove("chat-teardown");

    const removals = runProcess.mock.calls.map(([, args]) => (args as string[]).join(" "));
    const containerAt = removals.findIndex((entry) => entry.includes("rm -f"));
    const networkAt = removals.findIndex((entry) => entry.startsWith("network rm"));
    expect(containerAt).toBeGreaterThanOrEqual(0);
    expect(networkAt).toBeGreaterThan(containerAt);
    expect(sidecar.active("chat-teardown")).toBeUndefined();
  });

  it("removes sidecars and networks a previous backend left behind", async () => {
    runProcess.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "ps") return { ...result, stdout: "cloud-agent-browser-old-1\ncloud-agent-browser-old-2\n" };
      if (args[0] === "network" && args[1] === "ls") return { ...result, stdout: "cloud-agent-net-old-1\n" };
      return { ...result };
    });

    const swept = await new BrowserSidecar().sweepOrphans();
    expect(swept).toEqual({ containers: 2, networks: 1 });

    const removed = runProcess.mock.calls.map(([, args]) => (args as string[]).join(" "));
    expect(removed).toContain("rm -f cloud-agent-browser-old-1");
    expect(removed).toContain("rm -f cloud-agent-browser-old-2");
    expect(removed).toContain("network rm cloud-agent-net-old-1");
  });
});
