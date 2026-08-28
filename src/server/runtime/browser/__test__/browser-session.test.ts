import { beforeEach, describe, expect, it, vi } from "vitest";

const config = {
  BROWSER_ENABLED: true,
  BROWSER_IDLE_MINUTES: 10,
  BROWSER_ACTION_TIMEOUT_SECONDS: 30,
  BROWSER_NAVIGATION_TIMEOUT_SECONDS: 60,
  BROWSER_SCREENSHOT_MAX_BYTES: 10_485_760,
  WORKSPACE_ROOT: "/tmp/cloud-agents-tests",
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
};

const handle = {
  chatId: "chat-1",
  container: "cloud-agent-browser-chat-1",
  network: "cloud-agent-net-chat-1",
  endpoint: "http://127.0.0.1:49160",
  token: "a".repeat(64),
};

const ensureSidecar = vi.fn(async () => handle);
const removeSidecar = vi.fn(async () => {});
const activeSidecar = vi.fn(() => handle as typeof handle | undefined);
const ensureContainer = vi.fn(async () => "cloud-agent-chat-1");
const saveArtifact = vi.fn(async () => ({ id: "artifact-1" }));

vi.mock("../../../config.js", () => ({ config }));
vi.mock("../../../db/store.js", () => ({ saveArtifact }));
vi.mock("../../sandbox/sandbox.js", () => ({ sandbox: { ensureContainer } }));
vi.mock("../browser-sidecar.js", () => ({
  browserSidecar: { ensure: ensureSidecar, active: activeSidecar },
  removeBrowserEnvironment: removeSidecar,
}));

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
vi.stubGlobal("fetch", fetchMock);

const { BrowserSessions, BrowserDisabledError } = await import("../browser-session.js");

beforeEach(() => {
  config.BROWSER_ENABLED = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  ensureSidecar.mockClear();
  removeSidecar.mockClear();
  ensureContainer.mockClear();
});

describe("browser controller authentication", () => {
  it("presents the per-sidecar token on every controller request", async () => {
    const sessions = new BrowserSessions();
    await sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(String(url)).toContain("http://127.0.0.1:49160");
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${handle.token}`);
    }
  });

  it("turns a controller error into a readable failure without leaking the token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "blocked_host", message: "metadata is blocked" } }), { status: 403 }),
    );

    const sessions = new BrowserSessions();
    await expect(
      sessions.navigate({ chatId: "chat-1", repositoryPath: "/tmp/repo", url: "http://example.com" }),
    ).rejects.toThrow(/metadata is blocked/);

    await expect(
      sessions.navigate({ chatId: "chat-1", repositoryPath: "/tmp/repo", url: "http://example.com" }),
    ).rejects.not.toThrow(new RegExp(handle.token));
  });
});

describe("browser disabled", () => {
  it("refuses every browser action and starts no container", async () => {
    config.BROWSER_ENABLED = false;
    const sessions = new BrowserSessions();

    await expect(sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" })).rejects.toBeInstanceOf(
      BrowserDisabledError,
    );
    expect(ensureSidecar).not.toHaveBeenCalled();
    expect(ensureContainer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs no idle reaper when the browser is turned off", () => {
    config.BROWSER_ENABLED = false;
    const sessions = new BrowserSessions();
    sessions.startIdleReaper();
    expect(sessions.stopIdleReaper()).toBeUndefined();
  });
});

describe("idle cleanup", () => {
  it("keeps a sidecar that was used inside the idle window", async () => {
    const sessions = new BrowserSessions();
    await sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" });

    expect(await sessions.reapIdle()).toEqual([]);
    expect(removeSidecar).not.toHaveBeenCalled();
  });

  it("removes a sidecar once it passes the idle limit", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new BrowserSessions();
      await sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" });

      vi.advanceTimersByTime((config.BROWSER_IDLE_MINUTES + 1) * 60_000);
      expect(await sessions.reapIdle()).toEqual(["chat-1"]);
      expect(removeSidecar).toHaveBeenCalledWith("chat-1");

      expect(await sessions.reapIdle()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks activity per chat so a busy chat does not keep an idle one alive", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new BrowserSessions();
      await sessions.snapshot({ chatId: "chat-idle", repositoryPath: "/tmp/repo" });

      vi.advanceTimersByTime((config.BROWSER_IDLE_MINUTES - 1) * 60_000);
      await sessions.snapshot({ chatId: "chat-busy", repositoryPath: "/tmp/repo" });
      vi.advanceTimersByTime(2 * 60_000);

      expect(await sessions.reapIdle()).toEqual(["chat-idle"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("closing the browser", () => {
  it("asks the controller to close, then removes the container and network", async () => {
    const sessions = new BrowserSessions();
    await sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" });
    fetchMock.mockClear();

    expect(await sessions.close("chat-1")).toBe(true);
    const closeCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(closeCalls[0]?.[0])).toContain("/close");
    expect(removeSidecar).toHaveBeenCalledWith("chat-1");
    expect(await sessions.reapIdle()).toEqual([]);
  });

  it("still removes the environment when the controller cannot be reached", async () => {
    const sessions = new BrowserSessions();
    await sessions.snapshot({ chatId: "chat-1", repositoryPath: "/tmp/repo" });
    fetchMock.mockRejectedValue(new Error("connection refused"));

    await expect(sessions.close("chat-1")).resolves.toBe(true);
    expect(removeSidecar).toHaveBeenCalledWith("chat-1");
  });
});
