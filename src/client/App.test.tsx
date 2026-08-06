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

vi.mock("./api", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/api/repositories") return { repositories };
    if (path === "/api/sessions") return { sessions };
    if (path.startsWith("/api/sessions/")) {
      return { ...sessions[0], messages: [], runs: [], approvals: [] };
    }
    return {};
  }),
}));

const { App } = await import("./App");

beforeEach(() => {
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
