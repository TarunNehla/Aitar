import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: apiMock }));

const installations = [
  {
    installationId: 7,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "selected",
    status: "active",
  },
];

const repositories = [
  {
    githubRepositoryId: 11,
    name: "console",
    fullName: "acme/console",
    ownerLogin: "acme",
    private: true,
    defaultBranch: "main",
    cloneUrl: "https://github.com/acme/console.git",
  },
];

let githubInstallations = installations;

function respond(path: string) {
  if (path === "/api/github/status") return { appConfigured: true };
  if (path === "/api/github/installations") return { installations: githubInstallations };
  if (path.endsWith("/repositories")) return { repositories };
  if (path === "/api/repositories") return { repository: { id: "repository-1", defaultBranch: "main" } };
  if (path.endsWith("/chats")) return { session: { id: "session-1" } };
  return {};
}

const { RepositoryConnect, onboardingQuestion } = await import("../components/RepositoryConnect");

beforeEach(() => {
  githubInstallations = installations;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => respond(path));
});

afterEach(cleanup);

function openOnboarding(props: Partial<Parameters<typeof RepositoryConnect>[0]> = {}) {
  return render(
    <RepositoryConnect variant="page" onCreated={async () => undefined} {...props} />,
  );
}

describe("repository onboarding", () => {
  it("asks one question with two compact, icon-led choices", () => {
    openOnboarding();

    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: onboardingQuestion })).toBeDefined();

    const choices = Array.from(document.querySelectorAll(".source-choice"));
    expect(choices.map((choice) => choice.querySelector(".source-choice-label")?.textContent)).toEqual([
      "Connect GitHub repository",
      "Open public repository URL",
    ]);
    for (const choice of choices) expect(choice.querySelector("svg")).not.toBeNull();
  });

  it("shows no repository form, installation detail, or URL instruction before a choice", () => {
    openOnboarding();

    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(document.querySelector(".github-panel")).toBeNull();
    expect(document.body.textContent).not.toMatch(/install|permission|public github repositories/i);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("reveals only the GitHub step after picking GitHub", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));

    await waitFor(() => expect(screen.getByText("acme/console")).toBeDefined());
    expect(screen.getByRole("heading", { name: "Connect GitHub repository" })).toBeDefined();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(document.querySelector(".source-choice")).toBeNull();
  });

  it("reveals only the URL step after picking a public URL", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Open public repository URL"));

    await waitFor(() => expect(screen.getByLabelText("Repository URL")).toBeDefined());
    expect(document.querySelector(".github-panel")).toBeNull();
    expect(screen.getByRole("heading", { name: "Open public repository URL" })).toBeDefined();
  });

  it("keeps the technical options folded away behind one primary action", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Open public repository URL"));
    await waitFor(() => expect(screen.getByLabelText("Repository URL")).toBeDefined());

    const options = document.querySelector<HTMLDetailsElement>(".setup-options");
    expect(options?.open).toBe(false);
    expect(options?.querySelector("summary")?.textContent).toBe("Options");
    expect(document.querySelectorAll(".primary-button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open repository" })).toBeDefined();
  });

  it("asks for no branch anywhere in onboarding", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Open public repository URL"));
    await waitFor(() => expect(screen.getByLabelText("Repository URL")).toBeDefined());
    fireEvent.click(screen.getByText("Options"));

    expect(screen.queryByLabelText("Base branch")).toBeNull();
    expect(document.querySelector("input[name='baseBranch']")).toBeNull();
    expect(document.body.textContent).not.toMatch(/branch/i);
  });

  it("shows no branch beside a GitHub repository and sends none when connecting", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));
    await waitFor(() => expect(screen.getByText("acme/console")).toBeDefined());

    expect(document.querySelector(".branch-label")).toBeNull();
    expect(document.body.textContent).not.toMatch(/branch/i);

    fireEvent.click(screen.getByText("acme/console"));
    await waitFor(() => expect(apiMock.mock.calls.some(([path]) => path === "/api/repositories")).toBe(true));

    for (const [path, options] of apiMock.mock.calls as Array<[string, RequestInit | undefined]>) {
      if (!options?.body) continue;
      expect(Object.keys(JSON.parse(String(options.body))), path).not.toContain("defaultBranch");
      expect(Object.keys(JSON.parse(String(options.body))), path).not.toContain("baseBranch");
    }
  });

  it("offers a visible back action from every step", async () => {
    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));
    await waitFor(() => expect(screen.getByText("acme/console")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: onboardingQuestion })).toBeDefined();
    expect(screen.getByText("Open public repository URL")).toBeDefined();
  });

  it("shows a loading state while the GitHub accounts are read", () => {
    apiMock.mockImplementation(() => new Promise(() => undefined));
    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));

    expect(document.querySelector(".spinner")).not.toBeNull();
  });

  it("shows the progress of a connection inline", async () => {
    let release: (value: unknown) => void = () => undefined;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/repositories") return new Promise((resolve) => {
        release = resolve;
      });
      return respond(path);
    });

    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));
    await waitFor(() => expect(screen.getByText("acme/console")).toBeDefined());
    fireEvent.click(screen.getByText("acme/console"));

    await waitFor(() => expect(screen.getByText("Preparing the repository…")).toBeDefined());
    release({ repository: { id: "repository-1", defaultBranch: "main" } });
  });

  it("reports a failed connection inline and stays on the step", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/repositories") throw new Error("Repository could not be reached");
      return respond(path);
    });

    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));
    await waitFor(() => expect(screen.getByText("acme/console")).toBeDefined());
    fireEvent.click(screen.getByText("acme/console"));

    await waitFor(() => expect(document.querySelector(".form-error")).not.toBeNull());
    expect(screen.getByText("acme/console")).toBeDefined();
  });

  it("gives an empty GitHub account one useful next action", async () => {
    githubInstallations = [];
    openOnboarding();
    fireEvent.click(screen.getByText("Connect GitHub repository"));

    await waitFor(() => expect(screen.getByText("No GitHub account connected")).toBeDefined());
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeDefined();
    expect(document.querySelector(".github-empty")?.textContent).not.toMatch(/pick the repositories it may read/);
  });
});

describe("responsive onboarding and authentication layout", () => {
  const stylesheet = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
  const mobile = /@media \(max-width: 720px\) \{[\s\S]*?\n\}/.exec(stylesheet)?.[0] ?? "";

  it("caps the authentication card instead of stretching it on desktop", () => {
    const rule = /\.auth-card \{[^}]*\}/.exec(stylesheet)?.[0] ?? "";

    expect(rule).toContain("max-width: var(--auth-card-width)");
    expect(rule).toContain("width: 100%");
    expect(stylesheet).toContain("--auth-card-width: 440px");
  });

  it("keeps every mobile touch target at least 44px", () => {
    expect(stylesheet).toContain("--touch-target: 44px");
    expect(mobile).toContain("min-height: var(--touch-target)");
    expect(mobile).toContain("width: var(--touch-target)");
    for (const selector of [".auth-submit", ".provider-button", ".source-choice", ".password-toggle"]) {
      expect(mobile).toContain(selector);
    }
  });

  it("gives the small screen the available width and no sideways scroll", () => {
    expect(mobile).toContain(".auth-shell");
    expect(mobile).toContain("padding: var(--space-8) var(--space-6)");
    expect(/body \{[^}]*min-width: 320px/.test(stylesheet)).toBe(true);
    expect(stylesheet).not.toContain("overflow-x: scroll");
  });

  it("drives auth spacing, radius, focus, and state colour from tokens", () => {
    const auth = stylesheet.slice(stylesheet.indexOf("/* ── Authentication"));
    const literals = auth.match(/:\s*#[0-9a-f]{3,8}/gi) ?? [];

    expect(literals).toHaveLength(0);
    expect(auth).toContain("box-shadow: var(--focus-ring)");
    expect(auth).toContain("border-radius: var(--radius-panel)");
    expect(auth).toContain("height: var(--control-height)");
    expect(auth).toContain("color: var(--text-danger)");
  });

  it("collapses motion where the reader asked for less of it", () => {
    expect(stylesheet.trimEnd().endsWith("}")).toBe(true);
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
