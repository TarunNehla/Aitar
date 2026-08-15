import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("./auth-client", async () => {
  const actual = await vi.importActual<typeof import("./auth-client")>("./auth-client");
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
  { id: "repository-1", name: "Confidential project", repositoryUrl: "https://github.com/acme/secret", defaultBranch: "main" },
];
const agentBranch = "agent/78a2a00d-4f1e-4c2b-9a55-2b1f0c6d8e37";
const deepseekModel = "deepseek/deepseek-v4-flash-0731";

function newSession(title = "Private chat title") {
  return {
    session: {
      id: "session-1",
      title,
      repositoryId: "repository-1",
      defaultModel: deepseekModel,
      status: "active",
      branchName: agentBranch,
      baseBranch: "main",
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

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("./api", () => ({ api: apiMock }));

function respond(path: string, options?: RequestInit) {
  if (path === "/api/repositories") return { repositories };
  if (path === "/api/sessions") return { sessions };
  if (options?.method === "PATCH") {
    const { title } = JSON.parse(String(options.body)) as { title: string };
    sessions = sessions.map((item) => ({ ...item, session: { ...item.session, title } }));
    return { session: sessions[0].session };
  }
  if (path.endsWith("/messages")) return { message: { id: "message-sent" } };
  if (path.startsWith("/api/sessions/")) {
    return { ...sessions[0], messages: sessionMessages, runs: [], pullRequests: sessionPullRequests };
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
  window.history.replaceState({}, "", "/");
  sessions = [newSession()];
  sessionMessages = [];
  sessionPullRequests = [];
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
    expect(text).not.toContain(agentBranch);
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
    expect(card.textContent).not.toContain(agentBranch);
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
  it("puts a shortened branch inside the composer box, never in the sidebar", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer-branch")).not.toBeNull());
    const branch = document.querySelector(".composer-branch") as HTMLElement;
    const textarea = document.querySelector(".composer textarea") as HTMLTextAreaElement;

    expect(branch.textContent).toBe("agent/78a2a00d…");
    expect(branch.getAttribute("title")).toBe(agentBranch);
    expect(document.querySelector(".composer-box")?.contains(branch)).toBe(true);
    expect(textarea.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".sidebar")?.textContent).not.toContain("agent/");
  });

  it("carries no copy control beside the branch", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer-branch")).not.toBeNull());
    expect(document.querySelector(".copy-button")).toBeNull();
    expect(screen.queryByLabelText(/copy/i)).toBeNull();
  });

  it("puts the model dropdown in the composer box with no visible label", async () => {
    await openConsole();

    await waitFor(() => expect(document.querySelector(".model-select")).not.toBeNull());
    const select = screen.getByLabelText("Model");

    expect(document.querySelector(".composer-box")?.contains(select)).toBe(true);
    expect(document.querySelector(".composer-actions-end")?.contains(select)).toBe(true);
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

  it("stays quiet when the session is ready and speaks up when it is not", async () => {
    await openConsole();
    await waitFor(() => expect(document.querySelector(".composer")).not.toBeNull());
    expect(document.querySelector(".composer-status")).toBeNull();

    cleanup();
    sessions = [{ ...newSession(), session: { ...newSession().session, envStatus: "preparing" } }];
    await openConsole();

    await waitFor(() => expect(document.querySelector(".composer-status")?.textContent).toBe("Preparing"));
  });

  it("wraps the action row instead of scrolling the page sideways", async () => {
    const stylesheet = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
    const rule = /\.composer-actions \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(rule).toContain("flex-wrap: wrap");
    expect(rule).toContain("min-width: 0");
    expect(stylesheet).not.toContain(".conversation-header");
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
