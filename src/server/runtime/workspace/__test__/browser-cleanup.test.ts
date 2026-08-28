import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD_COMMIT = "1111111111111111111111111111111111111111";
const order: string[] = [];

const result = { stdout: "", stderr: "", exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 1 };

const runChecked = vi.fn(async (command: string, args: string[]) => {
  if (command === "git" && args.includes("rev-parse")) return { ...result, stdout: `${HEAD_COMMIT}\n` };
  return { ...result };
});

const runProcess = vi.fn(async (command: string, args: string[]) => {
  if (command === "docker" && args[0] === "rm") order.push("remove-agent-container");
  return { ...result };
});

const closeBrowser = vi.fn(async () => {
  order.push("close-browser");
  return true;
});
const stopAll = vi.fn(async () => {
  order.push("stop-processes");
});

vi.mock("../../process.js", () => ({ runProcess, runChecked }));
vi.mock("../../browser/browser-session.js", () => ({ browserSessions: { close: closeBrowser } }));
vi.mock("../../sandbox/sandbox-processes.js", () => ({ processManager: { stopAll } }));

const { workspaceManager } = await import("../workspace-manager.js");

beforeEach(() => {
  order.length = 0;
  runChecked.mockClear();
  runProcess.mockClear();
  closeBrowser.mockClear();
  stopAll.mockClear();
});

describe("chat eviction cleanup", () => {
  it("closes the browser as part of evicting a chat environment", async () => {
    await workspaceManager.evictChat({
      chatId: "chat-evicted",
      repositoryId: "repository-1",
      expectedHeadCommit: HEAD_COMMIT,
    });

    expect(closeBrowser).toHaveBeenCalledWith("chat-evicted");
  });

  it("stops processes and the browser before removing the chat container", async () => {
    await workspaceManager.evictChat({
      chatId: "chat-order",
      repositoryId: "repository-1",
      expectedHeadCommit: HEAD_COMMIT,
    });

    expect(order).toEqual(["stop-processes", "close-browser", "remove-agent-container"]);
  });

  it("leaves the browser alone when the chat branch is not safely mirrored", async () => {
    await expect(
      workspaceManager.evictChat({
        chatId: "chat-unsafe",
        repositoryId: "repository-1",
        expectedHeadCommit: "2222222222222222222222222222222222222222",
      }),
    ).rejects.toThrow(/not safely mirrored/);

    expect(closeBrowser).not.toHaveBeenCalled();
  });
});
