import { beforeEach, describe, expect, it, vi } from "vitest";

const sessions = {
  navigate: vi.fn(),
  snapshot: vi.fn(),
  act: vi.fn(),
  screenshot: vi.fn(),
  consoleMessages: vi.fn(),
  close: vi.fn(),
};

vi.mock("./browser-session.js", () => ({ browserSessions: sessions }));

const { createBrowserTools, redactsTypedText } = await import("./browser-tools.js");

const writer = { live: vi.fn() };

function tools(supportsImages = true) {
  return createBrowserTools({
    chatId: "chat-1",
    repositoryPath: "/tmp/repo",
    runId: "run-1",
    supportsImages,
    writer,
  });
}

function tool(name: string, supportsImages = true) {
  const found = tools(supportsImages).find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function shape(name: string) {
  const schema = tool(name).parameters as any;
  return {
    properties: Object.keys(schema.properties ?? {}).sort(),
    required: [...(schema.required ?? [])].sort(),
  };
}

beforeEach(() => {
  for (const mock of Object.values(sessions)) mock.mockReset();
  writer.live.mockReset();
});

describe("browser tool schemas", () => {
  it("exposes exactly the browser tool set", () => {
    expect(tools().map((entry) => entry.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_press",
      "browser_scroll",
      "browser_wait",
      "browser_screenshot",
      "browser_console",
      "browser_close",
    ]);
  });

  it("matches the required schema for every browser tool", () => {
    expect(shape("browser_navigate")).toEqual({ properties: ["timeout", "url", "waitUntil"], required: ["url"] });
    expect(shape("browser_snapshot")).toEqual({ properties: [], required: [] });
    expect(shape("browser_click")).toEqual({ properties: ["ref"], required: ["ref"] });
    expect(shape("browser_type")).toEqual({
      properties: ["clear", "ref", "sensitive", "submit", "text"],
      required: ["ref", "text"],
    });
    expect(shape("browser_select")).toEqual({ properties: ["ref", "values"], required: ["ref", "values"] });
    expect(shape("browser_press")).toEqual({ properties: ["key"], required: ["key"] });
    expect(shape("browser_scroll")).toEqual({ properties: ["amount", "direction"], required: ["direction"] });
    expect(shape("browser_wait")).toEqual({ properties: ["ref", "text", "timeout"], required: [] });
    expect(shape("browser_screenshot")).toEqual({ properties: ["fullPage"], required: [] });
    expect(shape("browser_console")).toEqual({ properties: ["cursor", "level", "limit"], required: [] });
    expect(shape("browser_close")).toEqual({ properties: [], required: [] });
  });

  it("offers no raw evaluation, script, or selector escape hatch", () => {
    for (const entry of tools()) {
      const properties = Object.keys((entry.parameters as any).properties ?? {});
      for (const forbidden of ["script", "code", "javascript", "evaluate", "expression", "selector", "xpath"]) {
        expect(properties, `${entry.name}.${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(tools().some((entry) => /evaluate|script|exec/i.test(entry.name))).toBe(false);
  });

  it("caps the navigation timeout at the platform limit", () => {
    const schema = tool("browser_navigate").parameters as any;
    expect(schema.properties.timeout.maximum).toBe(60);
  });
});

describe("sensitive input redaction", () => {
  it("never records a value the model marked sensitive", () => {
    expect(redactsTypedText({ sensitive: true, text: "hunter2" })).toBe(true);
  });

  it("never records a value typed into a password field", () => {
    expect(redactsTypedText({ password: true, text: "hunter2" })).toBe(true);
  });

  it("never records a value typed into a field whose name reads as a secret", () => {
    for (const name of ["Password", "Confirm password", "API token", "Security code", "Card number", "OTP"]) {
      expect(redactsTypedText({ elementName: name, text: "abc" }), name).toBe(true);
    }
  });

  it("never records a value that looks like a token", () => {
    for (const value of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "sk-live-abcdefghijklmnop",
      "eyJhbGciOi.eyJzdWIiOi.signature",
      "xoxb-1234567890-abcdefghij",
    ]) {
      expect(redactsTypedText({ text: value }), value).toBe(true);
    }
  });

  it("keeps ordinary text readable", () => {
    for (const value of ["hello@example.com", "India", "Sign in please", "42"]) {
      expect(redactsTypedText({ text: value }), value).toBe(false);
    }
  });

  it("shows REDACTED in the tool result and never the typed value", async () => {
    sessions.act.mockResolvedValue({
      element: { role: "input", name: "Password", password: true },
      url: "http://localhost:3000/login",
      navigated: false,
      durationMs: 12,
    });

    const outcome = await tool("browser_type").execute("call-1", { ref: "input-1", text: "hunter2" });
    const serialised = JSON.stringify(outcome);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).toContain("[REDACTED]");
    expect(outcome.details).toMatchObject({ redacted: true, characters: 7 });
    expect(JSON.stringify(writer.live.mock.calls)).not.toContain("hunter2");
  });
});

describe("model vision capability", () => {
  const capture = {
    artifactId: "artifact-1",
    url: "http://localhost:3000/",
    width: 1280,
    height: 800,
    bytes: 2_048,
    base64: "aGVsbG8=",
    truncated: false,
    durationMs: 40,
  };

  it("attaches the image when the model reads images", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const outcome = await tool("browser_screenshot", true).execute("call-1", {});

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text", "image"]);
    expect(outcome.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    expect(outcome.details).toMatchObject({ artifactId: "artifact-1", width: 1280, height: 800 });
  });

  it("returns a clear notice instead of an image when the model cannot read one", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const outcome = await tool("browser_screenshot", false).execute("call-1", {});

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text"]);
    expect((outcome.content[0] as any).text).toContain("does not read images");
    expect((outcome.content[0] as any).text).toContain("browser_snapshot");
    expect(outcome.details).toMatchObject({ artifactId: "artifact-1" });
  });
});

describe("screenshot metadata", () => {
  it("keeps image bytes out of the details the database sees", async () => {
    sessions.screenshot.mockResolvedValue({
      artifactId: "artifact-2",
      url: "http://localhost:3000/",
      width: 800,
      height: 600,
      bytes: 512,
      base64: "SU1BR0VCWVRFUw==",
      truncated: true,
      durationMs: 10,
    });

    const outcome = await tool("browser_screenshot").execute("call-9", { fullPage: true });
    expect(JSON.stringify(outcome.details)).not.toContain("SU1BR0VCWVRFUw==");
    expect(outcome.details).toMatchObject({
      artifactId: "artifact-2",
      url: "http://localhost:3000/",
      width: 800,
      height: 600,
      bytes: 512,
      fullPage: true,
      truncated: true,
    });
  });
});

describe("browser tool behaviour", () => {
  it("requires text or ref before waiting", async () => {
    await expect(tool("browser_wait").execute("call-1", {})).rejects.toThrow(/text or ref/);
    expect(sessions.act).not.toHaveBeenCalled();
  });

  it("reports the original localhost URL rather than the container alias", async () => {
    sessions.navigate.mockResolvedValue({
      url: "http://localhost:3000/dashboard",
      requestedUrl: "http://localhost:3000/",
      title: "Dashboard",
      status: 200,
      durationMs: 120,
      timedOut: false,
      translated: true,
      summary: { heading: "Dashboard", text: "Welcome" },
    });

    const outcome = await tool("browser_navigate").execute("call-1", { url: "http://localhost:3000/" });
    expect((outcome.content[0] as any).text).toContain("http://localhost:3000/dashboard");
    expect(JSON.stringify(outcome)).not.toContain("workspace:3000");
  });

  it("gives every interactive element a stable reference in the snapshot", async () => {
    sessions.snapshot.mockResolvedValue({
      url: "http://localhost:3000/",
      title: "Sign in",
      headings: ["Sign in"],
      bodyText: "Sign in to continue",
      truncated: false,
      elements: [
        { ref: "button-1", role: "button", name: "Sign in", disabled: false, checked: false },
        { ref: "input-2", role: "input", name: "Email address", disabled: false, checked: false },
        { ref: "link-3", role: "link", name: "Dashboard", disabled: false, checked: false },
      ],
    });

    const outcome = await tool("browser_snapshot").execute("call-1", {});
    expect((outcome.content[0] as any).text).toContain("[button-1] Sign in");
    expect((outcome.content[0] as any).text).toContain("[input-2] Email address");
    expect((outcome.content[0] as any).text).toContain("[link-3] Dashboard");
    expect(outcome.details).toMatchObject({ elements: 3 });
  });

  it("surfaces a stale reference as a clear instruction to snapshot again", async () => {
    sessions.act.mockRejectedValue(new Error("Reference button-1 is no longer valid. Call browser_snapshot to read the current page."));
    await expect(tool("browser_click").execute("call-1", { ref: "button-1" })).rejects.toThrow(/browser_snapshot/);
  });
});
