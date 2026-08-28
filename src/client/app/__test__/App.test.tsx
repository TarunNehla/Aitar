import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SessionState {
  data: { user: { id: string; name: string; email: string; image: string | null } } | null;
  isPending: boolean;
}

let sessionState: SessionState = { data: null, isPending: false };
let authMethods: { emailPassword: boolean } | null = { emailPassword: true };
const signOutMock = vi.fn(async () => {
  sessionState = { data: null, isPending: false };
});

vi.mock("../../auth/auth-client", async () => {
  const actual = await vi.importActual<typeof import("../../auth/auth-client")>("../../auth/auth-client");
  return {
    ...actual,
    useSession: () => sessionState,
    useAuthMethods: () => authMethods,
    signIn: { social: vi.fn(async () => ({ error: null })), email: vi.fn(async () => ({ error: null })) },
    signUp: { email: vi.fn(async () => ({ error: null })) },
    signOut: signOutMock,
    linkSocial: vi.fn(async () => ({ error: null })),
    listAccounts: vi.fn(async () => ({ data: [{ providerId: "google" }], error: null })),
    sendVerificationEmail: vi.fn(async () => ({ error: null })),
    requestPasswordReset: vi.fn(async () => ({ error: null })),
    resetPassword: vi.fn(async () => ({ error: null })),
    changePassword: vi.fn(async () => ({ error: null })),
    authClient: { getSession: vi.fn() },
  };
});

const repositories = [
  { id: "repository-1", name: "Confidential project", repositoryUrl: "https://github.com/acme/secret" },
];
const deepseekModel = "deepseek/deepseek-v4-flash-0731";

function newSession(title = "Private chat title") {
  return {
    session: {
      id: "session-1",
      title,
      repositoryId: "repository-1",
      defaultModel: deepseekModel,
      status: "active",
      baseCommit: "3f9a17c4b2e58d06a1c7f3e9b0d2a4c6e8f01234",
      headCommit: "7b1d24e8a3c05f96b2d8e1a7c4f60b3d9e520187",
      envStatus: "ready",
      lastActiveAt: "2026-01-01T00:00:00Z",
    },
    repository: repositories[0],
  };
}

let sessions = [newSession()];
let sessionMessages: unknown[] = [];
let sessionPullRequests: unknown[] = [];
let sessionRuns: unknown[] = [];

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: apiMock }));

function respond(path: string, options?: RequestInit) {
  if (path === "/api/repositories") return { repositories };
  if (path === "/api/sessions") return { sessions };
  if (options?.method === "PATCH") {
    const { title } = JSON.parse(String(options.body)) as { title: string };
    sessions = sessions.map((item) => ({ ...item, session: { ...item.session, title } }));
    return { session: sessions[0].session };
  }
  if (path.endsWith("/messages")) return { message: { id: "message-sent" } };
  if (path.endsWith("/chats")) return { session: { id: "created-session" } };
  if (path.startsWith("/api/sessions/")) {
    return { ...sessions[0], messages: sessionMessages, runs: sessionRuns, pullRequests: sessionPullRequests };
  }
  return {};
}

/** Mirrors the persisted shape of a user turn, whose text carries user visibility. */
function userMessage(id: string, text: string) {
  return {
    id,
    parentMessageId: null,
    role: "user",
    status: "complete",
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    blocks: [{ id: `block-${id}`, position: 0, type: "text", text, data: {}, visibility: "user" }],
  };
}

function sessionCard() {
  return document.querySelector(".session-button") as HTMLElement;
}

async function openComposer() {
  await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
  return document.querySelector(".composer") as HTMLFormElement;
}

/** Mirrors the persisted shape of an agent reply, whose text carries both visibilities. */
function assistantMessage(id: string, text: string) {
  return {
    id,
    parentMessageId: null,
    role: "assistant",
    status: "complete",
    model: deepseekModel,
    createdAt: "2026-01-01T00:00:10.000Z",
    blocks: [{ id: `block-${id}`, position: 0, type: "text", text, data: {}, visibility: "both" }],
  };
}

/** Drives the session stream by hand so a test can order events against fetches. */
class RecordingEventSource {
  static latest: RecordingEventSource | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: unknown = null;
  onopen: unknown = null;

  constructor() {
    RecordingEventSource.latest = this;
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {}

  ready() {
    for (const listener of this.listeners.get("ready") ?? []) listener();
  }

  emit(sequence: number, type: string, payload: Record<string, unknown> = {}) {
    this.onmessage?.({
      data: JSON.stringify({
        id: `event-${sequence}`,
        sessionId: "session-1",
        runId: "run-1",
        sequence,
        type,
        payload,
        createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + sequence * 1_000).toISOString(),
      }),
    });
  }
}

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

const { App } = await import("../App");

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  sessions = [newSession()];
  sessionMessages = [];
  sessionPullRequests = [];
  sessionRuns = [];
  sessionState = { data: null, isPending: false };
  authMethods = { emailPassword: true };
  signOutMock.mockClear();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, options?: RequestInit) => respond(path, options));
  class StubEventSource {
    addEventListener() {}
    close() {}
    onmessage: unknown = null;
    onerror: unknown = null;
    onopen: unknown = null;
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

  it("offers the email and password form only where the deployment enables it", () => {
    render(<App />);
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();

    cleanup();
    authMethods = { emailPassword: false };
    render(<App />);

    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
    expect(screen.getByText("Continue with Google")).toBeDefined();
  });

  it("waits for the sign-in methods before drawing the screen", () => {
    authMethods = null;
    render(<App />);

    expect(screen.getByText("Opening Aitar…")).toBeDefined();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("opens the reset view from an emailed link and takes the token out of the URL", async () => {
    window.history.replaceState({}, "", "/reset-password?token=reset-token-value");
    render(<App />);

    expect(screen.getByText("Choose a new password")).toBeDefined();
    expect(screen.getByLabelText("New password")).toBeDefined();
    await waitFor(() => expect(window.location.search).not.toContain("reset-token-value"));
    expect(document.body.textContent).not.toContain("reset-token-value");
  });

  it("explains an incomplete reset link instead of showing a form that cannot work", () => {
    window.history.replaceState({}, "", "/reset-password");
    render(<App />);

    expect(screen.getByRole("heading", { name: "That link expired" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Request a new link" })).toBeDefined();
    expect(screen.queryByLabelText("New password")).toBeNull();
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

async function openConsole() {
  sessionState = {
    data: { user: { id: "user-1", name: "Ada", email: "ada@example.com", image: null } },
    isPending: false,
  };
  render(<App />);
  await waitFor(() => expect(screen.getByText("Confidential project")).toBeDefined());
}

describe("tool rendering", () => {
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

  it("shows the pull request as a clickable card with its number, title, and state", async () => {
    sessionMessages = [
      toolMessage("call-1", "create_pull_request", {
        number: 42,
        url: "https://github.com/acme/service/pull/42",
        state: "open",
        draft: false,
        title: "Add caching",
      }),
    ];
    sessionPullRequests = [
      {
        number: 42,
        url: "https://github.com/acme/service/pull/42",
        state: "open",
        draft: false,
        title: "Add caching",
      },
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Add caching")).toBeDefined());
    const card = document.querySelector("a.pull-request-card") as HTMLAnchorElement;
    expect(card.href).toBe("https://github.com/acme/service/pull/42");
    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByText("Open")).toBeDefined();
  });

  it("keeps the published branch off the pull request card", async () => {
    const publishedBranch = "agent/add-caching-78a2a00d";
    sessionMessages = [
      toolMessage("call-1", "create_pull_request", {
        number: 42,
        url: "https://github.com/acme/service/pull/42",
        state: "open",
        draft: false,
        title: "Add caching",
        headBranch: publishedBranch,
        baseBranch: "main",
      }),
    ];
    sessionPullRequests = [
      { number: 42, url: "https://github.com/acme/service/pull/42", state: "open", draft: false, title: "Add caching" },
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("Add caching")).toBeDefined());
    const card = document.querySelector("a.pull-request-card") as HTMLAnchorElement;
    expect(card.textContent).not.toContain(publishedBranch);
    expect(card.textContent).not.toContain("agent/");
    expect(document.querySelector(".pull-request-branches")).toBeNull();
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

  it("shows tool paths relative to the repository", async () => {
    sessionMessages = [
      toolMessage("call-1", "read", { path: "/workspace/src/app/globals.css", lines: 12, bytes: 400 }),
      toolMessage("call-2", "ls", { path: "/workspace", entries: 9 }),
      toolMessage("call-3", "ls", { path: ".", entries: 4 }),
      toolMessage("call-4", "write", { path: "/workspace/src/main.tsx", bytes: 120 }),
    ];
    await openConsole();

    await waitFor(() => expect(screen.getByText("src/app/globals.css")).toBeDefined());
    expect(screen.getByText("src/main.tsx")).toBeDefined();
    expect(screen.getAllByText("repository")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("/workspace");
  });
});

describe("Aitar branding", () => {
  it("names the product in the sidebar and never says Cloud Agents", async () => {
    await openConsole();

    expect(document.querySelector(".brand")?.textContent).toBe("Aitar");
    expect(document.body.textContent).not.toContain("Cloud Agents");
  });

  it("names the product on the sign-in screen", () => {
    render(<App />);

    expect(screen.getByText("Aitar")).toBeDefined();
    expect(document.body.textContent).not.toContain("Cloud Agents");
  });
});

describe("conversation header", () => {
  it("renders no top metadata header above the thread", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
    expect(document.querySelector(".conversation-header")).toBeNull();
    expect(document.querySelector(".conversation > header")).toBeNull();
    expect(document.querySelector(".run-state")).toBeNull();
  });

  it("keeps branch, base branch, commit, model id, and Ready out of the conversation", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("agent/");
    expect(text).not.toContain("3f9a17c");
    expect(text).not.toContain("7b1d24e");
    expect(text).not.toContain(deepseekModel);
    expect(text).not.toContain("Ready");
  });

  it("leaves the thread scrollable above the composer", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".messages")).not.toBeNull());
    const conversation = document.querySelector(".conversation") as HTMLElement;
    expect(conversation.children[0].classList.contains("messages")).toBe(true);
  });
});

describe("session titles", () => {
  it("titles a new session from the first message and persists it", async () => {
    sessions = [newSession("New session")];
    await openConsole();

    const composer = await openComposer();
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "I want to make the background a bluish colour" } });
    fireEvent.submit(composer);

    await waitFor(() =>
      expect(sessionCard().textContent).toContain("Make the background a bluish colour"),
    );
    expect(sessionCard().textContent).not.toContain("New session");

    const patch = apiMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/sessions/session-1");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      title: "Make the background a bluish colour",
    });
  });

  it("keeps the derived title after a reload", async () => {
    sessions = [newSession("New session")];
    await openConsole();

    const composer = await openComposer();
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Add retry logic to the upload queue" } });
    fireEvent.submit(composer);
    await waitFor(() => expect(sessions[0].session.title).toBe("Add retry logic to the upload queue"));

    cleanup();
    await openConsole();

    await waitFor(() => expect(sessionCard().textContent).toContain("Add retry logic to the upload queue"));
  });

  it("derives a title for an existing session still called New session", async () => {
    sessions = [newSession("New session")];
    sessionMessages = [userMessage("message-1", "Please fix the flaky checkout test")];
    await openConsole();

    await waitFor(() => expect(sessionCard().textContent).toContain("Fix the flaky checkout test"));
    const patch = apiMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      title: "Fix the flaky checkout test",
    });
  });

  it("leaves an empty message without a derived title", async () => {
    sessions = [newSession("New session")];
    sessionMessages = [userMessage("message-1", "   ")];
    await openConsole();

    await waitFor(() => expect(sessionCard().textContent).toContain("New session"));
    expect(apiMock.mock.calls.some(([, options]) => (options as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });
});

describe("sidebar chat cards", () => {
  it("shows only the title and a muted activity time", async () => {
    await openConsole();

    const card = sessionCard();
    expect(card.querySelector(".session-name")?.textContent).toBe("Private chat title");
    expect(card.textContent).not.toContain("agent/");
    expect(card.textContent).not.toContain("3f9a17c");
    expect(card.textContent).not.toContain(deepseekModel);
    expect(card.textContent).not.toContain("session-1");
    expect(card.querySelector(".session-activity")).not.toBeNull();
  });

  it("offers the full title as a tooltip and marks the open chat", async () => {
    await openConsole();

    expect(sessionCard().getAttribute("title")).toBe("Private chat title");
    expect(sessionCard().getAttribute("aria-current")).toBe("true");
    expect(sessionCard().classList.contains("selected")).toBe(true);
  });
});

describe("composer metadata", () => {
  it("shows no branch chip and no copy control", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
    expect(document.querySelector(".composer-branch")).toBeNull();
    expect(document.querySelector(".copy-button")).toBeNull();
    expect(screen.queryByLabelText(/copy/i)).toBeNull();
    expect(document.querySelector(".composer")?.textContent).not.toContain("agent/");
  });

  it("puts the model dropdown in the composer box with no visible label", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".model-select")).not.toBeNull());
    const select = screen.getByLabelText("Model");

    expect(document.querySelector(".composer-box")?.contains(select)).toBe(true);
    expect(document.querySelector(".composer-actions")?.contains(select)).toBe(true);
    expect(document.querySelector(".composer")?.textContent).not.toContain("Model");
  });

  it("offers DeepSeek as the only model, labelled for people", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".model-select")).not.toBeNull());
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const options = [...select.options];

    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe("DeepSeek V4 Flash");
    expect(options[0].value).toBe(deepseekModel);
    expect(select.value).toBe(deepseekModel);
    expect(document.body.textContent).not.toContain(deepseekModel);
  });

  it("disables a model the session uses that is no longer offered", async () => {
    sessions = [{ ...newSession(), session: { ...newSession().session, defaultModel: "legacy/model" } }];
    await openConsole();

    await waitFor(() => expect(document.querySelector(".model-select")).not.toBeNull());
    const select = screen.getByLabelText("Model") as HTMLSelectElement;

    expect(select.value).toBe("legacy/model");
    expect([...select.options].find((option) => option.value === "legacy/model")?.disabled).toBe(true);
  });

  it("never puts a status line in the box, whatever the environment is doing", async () => {
    for (const envStatus of ["ready", "idle", "preparing", "failed"]) {
      cleanup();
      sessions = [{ ...newSession(), session: { ...newSession().session, envStatus } }];
      await openConsole();

      await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
      expect(document.querySelector(".composer-status"), envStatus).toBeNull();
      expect(document.querySelector(".composer")?.textContent, envStatus).not.toContain("Preparing");
    }
  });

  it("grows the draft up to five lines and no further", async () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
    const rule = /\.composer textarea \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(rule).toContain("max-height: 114px");
    expect(rule).toContain("overflow-y: auto");
    expect(rule).not.toContain("min-height");

    await openConsole();
    const composer = await openComposer();

    expect((composer.querySelector("textarea") as HTMLTextAreaElement).rows).toBe(1);
  });

  it("turns the send control into stop while a run is in flight", async () => {
    sessionRuns = [
      { id: "run-1", status: "running", model: deepseekModel, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    ];
    await openConsole();
    const composer = await openComposer();

    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeNull());
    expect(composer.querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([path]) => path === "/api/runs/run-1/cancel")).toBe(true),
    );

    // A draft turns it back into send, so guidance can still go out mid-run.
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "try the other approach" } });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
  });

  it("wraps the action row instead of scrolling the page sideways", async () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
    const rule = /\.composer-actions \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(rule).toContain("flex-wrap: wrap");
    expect(rule).toContain("min-width: 0");
    expect(stylesheet).not.toContain(".conversation-header");
  });
});

describe("branch information is gone from the interface", () => {
  it("renders no branch chip, label, or icon anywhere", async () => {
    sessionPullRequests = [
      { number: 42, url: "https://github.com/acme/service/pull/42", state: "open", draft: false, title: "Add caching" },
    ];
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
    for (const selector of [".composer-branch", ".pull-request-branches", ".branch-label", ".lucide-git-branch"]) {
      expect(document.querySelector(selector), selector).toBeNull();
    }
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/branch/i);
    expect(text).not.toContain("refs/");
  });

  it("keeps branch names, refs, and whole chat ids out of the console source", async () => {
    const app = readFileSync(resolve(process.cwd(), "src/client/app/App.tsx"), "utf8");
    const styles = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");

    for (const term of ["branchName", "headBranch", "baseBranch", "defaultBranch", "branch_published", "git-branch"]) {
      expect(app, term).not.toContain(term);
    }
    for (const rule of [".composer-branch", ".pull-request-branches", ".branch-label"]) {
      expect(styles, rule).not.toContain(rule);
    }
  });

  it("asks the server for a new chat without naming a branch", async () => {
    await openConsole();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    await waitFor(() =>
      expect(apiMock.mock.calls.some(([path]) => String(path).endsWith("/chats"))).toBe(true),
    );
    const [, options] = apiMock.mock.calls.find(([path]) => String(path).endsWith("/chats")) as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(options.body)))).not.toContain("baseBranch");
  });
});

describe("streamed agent replies", () => {
  it("keeps the reply on screen while the next tool call runs", async () => {
    sessionMessages = [userMessage("message-1", "Fix the header")];
    vi.stubGlobal("EventSource", RecordingEventSource);
    await openConsole();
    await openComposer();

    const stream = RecordingEventSource.latest as RecordingEventSource;
    act(() => stream.ready());
    act(() => stream.emit(1, "assistant_text_delta", { delta: "Reading the header component." }));

    await waitFor(() => expect(screen.getByText("Reading the header component.")).toBeDefined());

    // The run stores the reply before it announces it, but the stored copy only
    // reaches the client with the next session fetch, which the tool call outruns.
    act(() => stream.emit(2, "assistant_message_completed", { messageId: "message-2" }));
    act(() => stream.emit(3, "tool_started", { callId: "call-1", toolName: "read" }));
    await waitFor(() => expect(screen.getByText("Running")).toBeDefined());

    expect(screen.getByText("Reading the header component.")).toBeDefined();

    sessionMessages = [
      userMessage("message-1", "Fix the header"),
      assistantMessage("message-2", "Reading the header component."),
      toolMessage("call-1", "read", { path: "src/Header.tsx", lines: 12, bytes: 300 }),
    ];
    act(() => stream.emit(4, "tool_completed", { callId: "call-1", toolName: "read" }));

    await waitFor(() => expect(screen.getByText("Read")).toBeDefined());
    expect(screen.getAllByText("Reading the header component.")).toHaveLength(1);
    expect(document.querySelector(".assistant-message.streaming")).toBeNull();
  });

  it("ignores a session reply that a newer one has already overtaken", async () => {
    const waiting: Array<() => void> = [];
    apiMock.mockImplementation(async (path: string, options?: RequestInit) => {
      const body = respond(path, options);
      if (path !== "/api/sessions/session-1" || options) return body;
      return new Promise((resolve) => waiting.push(() => resolve(body)));
    });
    vi.stubGlobal("EventSource", RecordingEventSource);
    sessionMessages = [userMessage("message-1", "Fix the header")];
    await openConsole();

    const stream = RecordingEventSource.latest as RecordingEventSource;
    act(() => stream.ready());
    await waitFor(() => expect(waiting).toHaveLength(1));

    sessionMessages = [
      userMessage("message-1", "Fix the header"),
      assistantMessage("message-2", "The header is centred now."),
    ];
    act(() => stream.emit(1, "run_completed", { outputTokens: 10 }));
    await waitFor(() => expect(waiting).toHaveLength(2));

    act(() => waiting[1]());
    await waitFor(() => expect(screen.getByText("The header is centred now.")).toBeDefined());

    act(() => waiting[0]());
    await waitFor(() => expect(screen.getByText("Fix the header")).toBeDefined());
    expect(screen.getByText("The header is centred now.")).toBeDefined();
  });
});

describe("context compaction", () => {
  async function streamCompaction() {
    sessionMessages = [userMessage("message-1", "Fix the header")];
    vi.stubGlobal("EventSource", RecordingEventSource);
    await openConsole();
    await openComposer();
    const stream = RecordingEventSource.latest as RecordingEventSource;
    act(() => stream.ready());
    return stream;
  }

  it("announces the pause while the agent is shortening its own context", async () => {
    const stream = await streamCompaction();

    act(() =>
      stream.emit(1, "compaction_started", {
        reason: "threshold",
        tokensBefore: 152_275,
        limit: 147_456,
        contextWindow: 163_840,
        summarisedMessages: 48,
        preservedMessages: 3,
      }),
    );

    await waitFor(() => expect(screen.getByText("Optimising context")).toBeDefined());
    expect(screen.getByText("the context window was nearly full · summarising 48 earlier messages")).toBeDefined();
    expect(document.querySelector(".timeline-event.working.notice")).not.toBeNull();
  });

  it("replaces the in-flight line with what the compaction actually did", async () => {
    const stream = await streamCompaction();

    act(() => stream.emit(1, "compaction_started", { reason: "threshold", summarisedMessages: 48 }));
    await waitFor(() => expect(screen.getByText("Optimising context")).toBeDefined());

    act(() =>
      stream.emit(2, "compaction_completed", {
        reason: "threshold",
        snapshotId: "snapshot-1",
        tokensBefore: 152_275,
        tokensAfter: 2_294,
        summarisedMessages: 48,
        preservedMessages: 3,
      }),
    );

    await waitFor(() => expect(screen.getByText("Context optimised")).toBeDefined());
    expect(screen.queryByText("Optimising context")).toBeNull();
    expect(screen.getByText("48 earlier messages summarised · 3 recent requests kept in full")).toBeDefined();
    expect(screen.getByText(`${(152_275).toLocaleString()} → ${(2_294).toLocaleString()} tokens`)).toBeDefined();
  });

  it("names the overflow that forced the compaction", async () => {
    const stream = await streamCompaction();

    act(() => stream.emit(1, "compaction_started", { reason: "context_overflow", summarisedMessages: 1 }));

    await waitFor(() =>
      expect(screen.getByText("the model refused the request as too long · summarising 1 earlier message")).toBeDefined(),
    );
  });

  it("reports a failed compaction without claiming the context shrank", async () => {
    const stream = await streamCompaction();

    act(() => stream.emit(1, "compaction_started", { reason: "threshold", summarisedMessages: 12 }));
    act(() => stream.emit(2, "compaction_failed", { reason: "threshold", error: "The summary model timed out" }));

    await waitFor(() => expect(screen.getByText("Context optimisation failed")).toBeDefined());
    expect(screen.getByText("The summary model timed out")).toBeDefined();
    expect(screen.queryByText("Context optimised")).toBeNull();
    expect(document.querySelector(".timeline-event.warning.notice")).not.toBeNull();
  });

  it("keeps the compaction visible after the finished run collapses its steps", async () => {
    const stream = await streamCompaction();

    act(() => stream.emit(1, "run_started", {}));
    act(() => stream.emit(2, "tool_started", { callId: "call-1", toolName: "read" }));
    act(() =>
      stream.emit(3, "compaction_completed", {
        reason: "threshold",
        tokensBefore: 152_275,
        tokensAfter: 2_294,
        summarisedMessages: 48,
        preservedMessages: 3,
      }),
    );
    act(() => stream.emit(4, "run_completed", { outputTokens: 10 }));

    // The tool call folds into the run summary; the compaction stays on the thread.
    await waitFor(() => expect(screen.getByText(/^Worked for/)).toBeDefined());
    expect(screen.getByText("Context optimised")).toBeDefined();
    expect(screen.getByText(`${(152_275).toLocaleString()} → ${(2_294).toLocaleString()} tokens`)).toBeDefined();
  });
});

describe("accessible labels", () => {
  it("names every control the composer and sidebar add", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer-actions")).not.toBeNull());
    expect(screen.getByLabelText("Model")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New session" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New repository" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New session in Confidential project" })).toBeDefined();
  });
});
