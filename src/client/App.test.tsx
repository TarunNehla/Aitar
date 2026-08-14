import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SessionState {
  data: { user: { id: string; name: string; email: string; image: string | null } } | null;
  isPending: boolean;
}

let sessionState: SessionState = { data: null, isPending: false };
const signOutMock = vi.fn(async () => {
  sessionState = { data: null, isPending: false };
});

vi.mock("./auth-client", async () => {
  const actual = await vi.importActual<typeof import("./auth-client")>("./auth-client");
  return {
    ...actual,
    useSession: () => sessionState,
    signIn: { social: vi.fn(async () => ({ error: null })) },
    signOut: signOutMock,
    linkSocial: vi.fn(async () => ({ error: null })),
    listAccounts: vi.fn(async () => ({ data: [{ providerId: "google" }], error: null })),
    authClient: { getSession: vi.fn() },
  };
});

const repositories = [
  { id: "repository-1", name: "Confidential project", repositoryUrl: "https://github.com/acme/secret", defaultBranch: "main" },
];
const sessions = [
  {
    session: {
      id: "session-1",
      title: "Private chat title",
      repositoryId: "repository-1",
      defaultModel: "test/model",
      status: "active",
      branchName: "agent/session-1",
      baseBranch: "main",
      baseCommit: null,
      headCommit: null,
      envStatus: "ready",
    },
    repository: repositories[0],
  },
];

let sessionMessages: unknown[] = [];
let sessionPullRequests: unknown[] = [];

vi.mock("./api", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/api/repositories") return { repositories };
    if (path === "/api/sessions") return { sessions };
    if (path.startsWith("/api/sessions/")) {
      return { ...sessions[0], messages: sessionMessages, runs: [], pullRequests: sessionPullRequests };
    }
    return {};
  }),
}));

/** Builds the tool-result message shape the runner persists, summary only. */
function toolMessage(id: string, toolName: string, data: Record<string, unknown>) {
  return {
    id,
    parentMessageId: null,
    role: "tool",
    status: "complete",
    model: null,
    createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + Number(id.split("-")[1]) * 1_000).toISOString(),
    blocks: [
      {
        id: `block-${id}`,
        position: 0,
        type: "tool_result",
        text: "summary",
        data: { callId: id, toolName, isError: false, ...data },
        visibility: "model",
      },
    ],
  };
}

const { App } = await import("./App");

beforeEach(() => {
  sessionMessages = [];
  sessionPullRequests = [];
  sessionState = { data: null, isPending: false };
  signOutMock.mockClear();
  class StubEventSource {
    addEventListener() {}
    close() {}
    onmessage: unknown = null;
    onerror: unknown = null;
  }
  vi.stubGlobal("EventSource", StubEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authenticated application state", () => {
  it("shows the sign-in screen when there is no session", () => {
    render(<App />);

    expect(screen.getByText("Sign in to continue")).toBeDefined();
    expect(screen.getByText("Continue with Google")).toBeDefined();
    expect(screen.getByText("Continue with GitHub")).toBeDefined();
  });

  it("surfaces an OAuth error from the callback", () => {
    window.history.replaceState({}, "", "/?error=account_not_linked");
    render(<App />);

    expect(screen.getByText(/not connected yet/)).toBeDefined();
    window.history.replaceState({}, "", "/");
  });

  it("shows the console for a signed-in user", async () => {
    sessionState = {
      data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    };
    render(<App />);

    await waitFor(() => expect(screen.getByText("Confidential project")).toBeDefined());
    expect(screen.getAllByText("Private chat title").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada")).toBeDefined();
  });

  it("clears the previous user's data after signing out", async () => {
    sessionState = {
      data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    };
    const view = render(<App />);
    await waitFor(() => expect(screen.getByText("Confidential project")).toBeDefined());

    sessionState = { data: null, isPending: false };
    view.rerender(<App />);

    expect(screen.getByText("Sign in to continue")).toBeDefined();
    expect(screen.queryByText("Confidential project")).toBeNull();
    expect(screen.queryByText("Private chat title")).toBeNull();
    expect(screen.queryByText("ada@example.com")).toBeNull();
  });

  it("remounts the console with fresh state when the signed-in user changes", async () => {
    sessionState = {
      data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    };
    const view = render(<App />);
    await waitFor(() => expect(screen.getByText("Ada")).toBeDefined());

    sessionState = {
      data: { user: { id: "user-2", name: "Grace", email: "grace@example.com", image: null } },
      isPending: false,
    };
    view.rerender(<App />);

    expect(screen.queryByText("Ada")).toBeNull();
    await waitFor(() => expect(screen.getByText("Grace")).toBeDefined());
  });
});

describe("tool rendering", () => {
  async function openConsole() {
    sessionState = {
      data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null } },
      isPending: false,
    };
    render(<App />);
    await waitFor(() => expect(screen.getByText("Confidential project")).toBeDefined());
  }

  it("renders one concise line per tool with muted counts", async () => {
    sessionMessages = [
      toolMessage("call-1", "read", { path: "src/file.ts", lines: 42, bytes: 2_048 }),
      toolMessage("call-2", "edit", { path: "src/file.ts", edits: 1 }),
      toolMessage("call-3", "write", { path: "src/new.ts", bytes: 120 }),
      toolMessage("call-4", "grep", { pattern: "pattern", matches: 7, files: 3 }),
      toolMessage("call-5", "find", { pattern: "*.ts", results: 12 }),
      toolMessage("call-6", "ls", { path: "src", entries: 9 }),
      toolMessage("call-7", "bash", { command: "pnpm test", exitCode: 0, durationMs: 4_200 }),
      toolMessage("call-8", "start_process", { name: "dev-server", processId: "abc123" }),
      toolMessage("call-9", "process_logs", { name: "dev-server", stdoutBytes: 900, stderrBytes: 0 }),
      toolMessage("call-10", "stop_process", { name: "dev-server" }),
    ];
    await openConsole();

    for (const [verb, code] of [
      ["Read", "src/file.ts"],
      ["Edited", "src/file.ts"],
      ["Wrote", "src/new.ts"],
      ["Searched for", "pattern"],
      ["Found files", "*.ts"],
      ["Listed", "src"],
      ["Ran", "pnpm test"],
      ["Started", "dev-server"],
      ["Stopped", "dev-server"],
    ]) {
      await waitFor(() => expect(screen.getAllByText(verb).length, verb).toBeGreaterThan(0));
      expect(screen.getAllByText(code).length, code).toBeGreaterThan(0);
    }

    expect(screen.getByText("Read process logs")).toBeDefined();
    expect(screen.getByText("42 lines · 2.0 KB")).toBeDefined();
    expect(screen.getByText("7 matches · 3 files")).toBeDefined();
    expect(screen.getByText("exit 0 · 4.2s")).toBeDefined();
    expect(screen.getByText("1 edit")).toBeDefined();
  });

  it("shows no expansion control when a tool has no extra content", async () => {
    sessionMessages = [toolMessage("call-1", "read", { path: "src/file.ts", lines: 4, bytes: 90 })];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Read")).toBeDefined());
    expect(document.querySelectorAll("details.tool-message")).toHaveLength(0);
    expect(document.querySelectorAll(".tool-result")).toHaveLength(1);
  });

  it("shows the pull request as a clickable card with its branches and state", async () => {
    sessionMessages = [
      toolMessage("call-1", "create_pull_request", {
        number: 42,
        url: "https://github.com/acme/service/pull/42",
        state: "open",
        draft: false,
        title: "Add caching",
        headBranch: "agent/session-1",
        baseBranch: "main",
      }),
    ];
    sessionPullRequests = [
      {
        number: 42,
        url: "https://github.com/acme/service/pull/42",
        state: "open",
        draft: false,
        title: "Add caching",
        headBranch: "agent/session-1",
        baseBranch: "main",
      },
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Add caching")).toBeDefined());
    const card = document.querySelector("a.pull-request-card") as HTMLAnchorElement;
    expect(card.href).toBe("https://github.com/acme/service/pull/42");
    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByText("Open")).toBeDefined();
    expect(card.textContent).toContain("agent/session-1");
    expect(card.textContent).toContain("main");
  });

  it("renders one concise line per browser action", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_navigate", {
        url: "http://localhost:3000",
        title: "Sign in",
        status: 200,
        durationMs: 1_200,
      }),
      toolMessage("call-2", "browser_snapshot", { elements: 12 }),
      toolMessage("call-3", "browser_click", { label: "Sign in", navigated: true, durationMs: 300 }),
      toolMessage("call-4", "browser_type", { label: "Email", characters: 18, redacted: true, durationMs: 100 }),
      toolMessage("call-5", "browser_select", { label: "Country", values: ["India"] }),
      toolMessage("call-6", "browser_press", { key: "Enter" }),
      toolMessage("call-7", "browser_console", { messages: 8, errors: 3 }),
      toolMessage("call-8", "browser_close", { closed: true }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Opened")).toBeDefined());
    expect(screen.getByText("http://localhost:3000")).toBeDefined();
    expect(screen.getByText("Read page structure")).toBeDefined();
    expect(screen.getByText("Clicked “Sign in”")).toBeDefined();
    expect(screen.getByText("Typed into “Email”")).toBeDefined();
    expect(screen.getByText("Selected “India”")).toBeDefined();
    expect(screen.getByText("Pressed")).toBeDefined();
    expect(screen.getByText("Enter")).toBeDefined();
    expect(screen.getByText("Read 3 console errors")).toBeDefined();
    expect(screen.getByText("Closed browser")).toBeDefined();
    expect(screen.getByText("18 characters · 0.1s")).toBeDefined();
  });

  it("never shows a typed value, only that something was typed", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_type", { label: "Password", characters: 7, redacted: true }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Typed into “Password”")).toBeDefined());
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("renders a screenshot as a thumbnail served by the authenticated artifact route", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_screenshot", {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1280,
        height: 800,
        bytes: 188_416,
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Captured screenshot")).toBeDefined());
    expect(screen.getByText("1280 × 800 · 184.0 KB")).toBeDefined();

    const image = document.querySelector(".screenshot-thumb img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/sessions/session-1/artifacts/artifact-1");
    expect(image.getAttribute("src")).not.toContain("/Users");
    expect(document.querySelectorAll("details.tool-message")).toHaveLength(0);
  });

  it("keeps showing the screenshot when a vision model described it", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_screenshot", {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1280,
        height: 800,
        bytes: 188_416,
        question: "Is the heading centred?",
        routing: "delegated",
        visionModel: "google/gemini-3.7-flash",
        primaryModel: "deepseek/deepseek-v4-flash-0731",
        confidence: 0.86,
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Captured screenshot")).toBeDefined());
    const image = document.querySelector(".screenshot-thumb img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/sessions/session-1/artifacts/artifact-1");
    expect(document.querySelectorAll("details.tool-message")).toHaveLength(0);
  });

  it("shows the inspecting model only as muted technical detail", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_screenshot", {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1280,
        height: 800,
        bytes: 188_416,
        routing: "delegated",
        visionModel: "google/gemini-3.7-flash",
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Captured screenshot")).toBeDefined());
    const muted = document.querySelector(".timeline-event-detail.tool-metadata");
    expect(muted?.textContent).toContain("Vision analysis completed · google/gemini-3.7-flash");
    expect(document.querySelector(".timeline-event-verb")?.textContent).toBe("Captured screenshot");
  });

  it("names no vision model when the run's own model read the image", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_screenshot", {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1280,
        height: 800,
        bytes: 188_416,
        routing: "direct",
        primaryModel: "google/gemini-3.7-flash",
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Captured screenshot")).toBeDefined());
    expect(screen.getByText("1280 × 800 · 184.0 KB")).toBeDefined();
    expect(document.body.textContent).not.toContain("Vision analysis completed");
  });

  it("renders an image inspection as its own activity row with the screenshot", async () => {
    sessionMessages = [
      toolMessage("call-1", "inspect_image", {
        artifactId: "artifact-1",
        bytes: 188_416,
        mimeType: "image/png",
        question: "Do the two cards have equal padding?",
        routing: "delegated",
        visionModel: "google/gemini-3.7-flash",
        confidence: 0.7,
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Inspected screenshot")).toBeDefined());
    const muted = document.querySelector(".timeline-event-detail.tool-metadata");
    expect(muted?.textContent).toContain("Vision analysis completed · google/gemini-3.7-flash");

    const image = document.querySelector(".screenshot-thumb img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/sessions/session-1/artifacts/artifact-1");
    expect(document.querySelectorAll("details.tool-message")).toHaveLength(0);
    expect(document.querySelectorAll(".browser-panel, .activity-panel, [data-browser-panel]")).toHaveLength(0);
  });

  it("never renders image bytes or a local path from a screenshot row", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_screenshot", {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1280,
        height: 800,
        bytes: 188_416,
        routing: "delegated",
        visionModel: "google/gemini-3.7-flash",
      }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Captured screenshot")).toBeDefined());
    expect(document.body.innerHTML).not.toContain("base64");
    expect(document.body.innerHTML).not.toContain("/Users");
    expect(document.body.innerHTML).not.toContain(".cloud-agent/artifacts");
  });

  it("shows a failed inspection as a failed row", async () => {
    sessionMessages = [
      {
        ...toolMessage("call-1", "inspect_image", { artifactId: "artifact-1" }),
        blocks: [
          {
            id: "block-call-1",
            position: 0,
            type: "tool_result",
            text: "summary",
            data: { callId: "call-1", toolName: "inspect_image", isError: true, artifactId: "artifact-1" },
            visibility: "model",
          },
        ],
      },
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Could not inspect screenshot")).toBeDefined());
    expect(document.querySelectorAll(".tool-result.failed")).toHaveLength(1);
    expect(document.querySelectorAll(".screenshot-thumb")).toHaveLength(0);
  });

  it("shows a browser failure as a failed row", async () => {
    sessionMessages = [
      {
        ...toolMessage("call-1", "browser_navigate", { url: "http://localhost:3000" }),
        blocks: [
          {
            id: "block-call-1",
            position: 0,
            type: "tool_result",
            text: "summary",
            data: { callId: "call-1", toolName: "browser_navigate", isError: true, url: "http://localhost:3000" },
            visibility: "model",
          },
        ],
      },
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Could not open")).toBeDefined());
    expect(document.querySelectorAll(".tool-result.failed")).toHaveLength(1);
  });

  it("has no separate browser activity panel", async () => {
    sessionMessages = [
      toolMessage("call-1", "browser_navigate", { url: "http://localhost:3000", title: "Sign in" }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Opened")).toBeDefined());
    expect(document.querySelectorAll(".browser-panel, .activity-panel, [data-browser-panel]")).toHaveLength(0);
    expect(document.querySelectorAll(".tool-result")).toHaveLength(1);
  });

  it("has no approval controls anywhere in the console", async () => {
    sessionMessages = [toolMessage("call-1", "bash", { command: "pnpm add left-pad", exitCode: 0, durationMs: 900 })];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Ran")).toBeDefined());
    expect(screen.queryByText(/Allow once/i)).toBeNull();
    expect(screen.queryByText(/Deny/i)).toBeNull();
    expect(screen.queryByText(/approval/i)).toBeNull();
    expect(document.querySelectorAll(".approval-card")).toHaveLength(0);
  });
});
