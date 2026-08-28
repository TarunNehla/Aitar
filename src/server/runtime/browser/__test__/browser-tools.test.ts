import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessions = {
  navigate: vi.fn(),
  snapshot: vi.fn(),
  act: vi.fn(),
  screenshot: vi.fn(),
  consoleMessages: vi.fn(),
  close: vi.fn(),
};

vi.mock("../browser-session.js", () => ({ browserSessions: sessions }));

const store = { getArtifactForChat: vi.fn() };
vi.mock("../../../db/store.js", () => store);

const config = {
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
  BROWSER_NAVIGATION_TIMEOUT_SECONDS: 60,
  VISION_ROUTING_MODE: "auto" as string,
  VISION_MODEL: "vision/observer",
  VISION_MAX_IMAGE_BYTES: 10_485_760,
  VISION_REQUEST_TIMEOUT_SECONDS: 60,
  VISION_CAPABILITY_CACHE_TTL_SECONDS: 21_600,
  VISION_CAPABILITY_OVERRIDES: {} as Record<string, string>,
};
vi.mock("../../../config.js", () => ({ config }));

const { createBrowserTools, redactsTypedText } = await import("../browser-tools.js");
const { createRunVisionRouter } = await import("../../model/vision-router.js");
const { RunCostAccount } = await import("../../model/run-cost.js");

const writer = { live: vi.fn() };
const complete = vi.fn();
const capabilities = { capabilityOf: vi.fn(), costRatesFor: vi.fn(), cachedModalities: vi.fn(), clear: vi.fn() };

let cost: InstanceType<typeof RunCostAccount>;
let vision: ReturnType<typeof createRunVisionRouter>;

export function visionMessage(text: string, costTotal = 0.01, input = 1_000, output = 200) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
    provider: "openrouter" as const,
    model: "vision/observer",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  };
}

function tools(supportsImages = true, maxCostUsd = 2) {
  cost = new RunCostAccount(maxCostUsd);
  vision = createRunVisionRouter({
    primaryModelId: "primary/model",
    supportsImages,
    cost,
    complete: complete as any,
    apiKey: () => "test-key",
    capabilities: capabilities as any,
  });
  return createBrowserTools({
    chatId: "chat-1",
    repositoryPath: "/tmp/repo",
    runId: "run-1",
    vision,
    writer,
  });
}

async function writeArtifact(mimeType: string | null, contents = "screenshot-bytes") {
  const directory = await mkdtemp(join(tmpdir(), "vision-artifact-"));
  const id = randomUUID();
  const storagePath = join(directory, `${id}.bin`);
  await writeFile(storagePath, contents);
  return {
    contents,
    row: {
      id,
      sessionId: "chat-1",
      name: "screenshot.png",
      type: "browser_screenshot",
      mimeType,
      storagePath,
      size: Buffer.byteLength(contents),
      metadata: {},
    },
  };
}

function tool(name: string, supportsImages = true, maxCostUsd = 2) {
  const found = tools(supportsImages, maxCostUsd).find((entry) => entry.name === name);
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
  complete.mockReset();
  store.getArtifactForChat.mockReset();
  config.VISION_ROUTING_MODE = "auto";
  config.VISION_MODEL = "vision/observer";
  config.VISION_MAX_IMAGE_BYTES = 10_485_760;
  capabilities.capabilityOf.mockReset();
  capabilities.costRatesFor.mockReset();
  capabilities.capabilityOf.mockResolvedValue({
    modelId: "vision/observer",
    modalities: ["text", "image"],
    supportsImages: true,
    source: "metadata",
  });
  capabilities.costRatesFor.mockResolvedValue({ input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 });
  complete.mockResolvedValue(
    visionMessage(
      JSON.stringify({
        answer: "The heading is centred.",
        observations: ["The header is 64px tall."],
        visibleText: ["Dashboard"],
        visualProblems: [{ description: "The footer overlaps the table.", severity: "high" }],
        confidence: 0.82,
      }),
    ),
  );
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
      "inspect_image",
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
    expect(shape("browser_screenshot")).toEqual({ properties: ["fullPage", "question"], required: [] });
    expect(shape("inspect_image")).toEqual({
      properties: ["artifactId", "question"],
      required: ["artifactId", "question"],
    });
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

describe("screenshot routing", () => {
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

  it("attaches the image and asks nothing of a vision model when the model reads images", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const outcome = await tool("browser_screenshot", true).execute("call-1", { question: "Is the heading centred?" });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text", "image"]);
    expect(outcome.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    expect((outcome.content[0] as any).text).toContain("Is the heading centred?");
    expect(outcome.details).toMatchObject({ artifactId: "artifact-1", routing: "direct", width: 1280 });
    expect(complete).not.toHaveBeenCalled();
    expect(cost.totals().visionRequests).toBe(0);
    expect(cost.spentUsd()).toBe(0);
  });

  it("delegates to the vision model and returns text when the model cannot read images", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const outcome = await tool("browser_screenshot", false).execute("call-1", { question: "Is anything overlapping?" });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text"]);
    const text = (outcome.content[0] as any).text;
    expect(text).toContain("The heading is centred.");
    expect(text).toContain("The footer overlaps the table.");
    expect(text).toContain("vision/observer");
    expect(outcome.details).toMatchObject({
      artifactId: "artifact-1",
      routing: "delegated",
      visionModel: "vision/observer",
      structured: true,
      confidence: 0.82,
      visualProblems: 1,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("never sends an image content block to a text-only model", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const outcome = await tool("browser_screenshot", false).execute("call-1", {});
    expect(outcome.content.some((block: any) => block.type === "image")).toBe(false);
  });

  it("uses the default inspection question when none is given", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    await tool("browser_screenshot", false).execute("call-1", {});

    const context = complete.mock.calls[0][1];
    expect(JSON.stringify(context.messages)).toContain("Describe the visible layout");
  });

  it("sends the question and the image to the vision model, and nothing else", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    await tool("browser_screenshot", false).execute("call-1", { question: "Any overflow?" });

    const [model, context] = complete.mock.calls[0];
    expect(model.id).toBe("vision/observer");
    expect(model.input).toContain("image");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].content).toEqual([
      { type: "text", text: "Question: Any overflow?" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(context.systemPrompt).toContain("Report only what is visible");
  });

  it("still returns the captured screenshot when the vision model fails", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    complete.mockRejectedValue(new Error("upstream is down"));

    const outcome = await tool("browser_screenshot", false).execute("call-1", { question: "Centred?" });
    const text = (outcome.content[0] as any).text;
    expect(text).toContain("Captured 1280×800 screenshot");
    expect(text).toContain("could not be analysed");
    expect(text).toContain("upstream is down");
    expect(outcome.details).toMatchObject({ artifactId: "artifact-1", routing: "unavailable" });
  });

  it("still returns the captured screenshot when the image is too large to analyse", async () => {
    config.VISION_MAX_IMAGE_BYTES = 512;
    sessions.screenshot.mockResolvedValue(capture);

    const outcome = await tool("browser_screenshot", false).execute("call-1", {});
    expect((outcome.content[0] as any).text).toContain("Captured 1280×800 screenshot");
    expect(outcome.details).toMatchObject({ artifactId: "artifact-1", routing: "unavailable" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("propagates a cancellation instead of reporting a failed analysis", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const controller = new AbortController();
    complete.mockImplementation(async () => {
      controller.abort();
      throw new Error("Browser action cancelled");
    });

    await expect(
      tool("browser_screenshot", false).execute("call-1", {}, controller.signal),
    ).rejects.toThrow(/cancelled/);
  });

  it("keeps image bytes out of details and out of live events on both routes", async () => {
    sessions.screenshot.mockResolvedValue({ ...capture, base64: "SU1BR0VCWVRFUw==" });
    for (const supportsImages of [true, false]) {
      writer.live.mockReset();
      const outcome = await tool("browser_screenshot", supportsImages).execute("call-1", {});
      expect(JSON.stringify(outcome.details)).not.toContain("SU1BR0VCWVRFUw==");
      expect(JSON.stringify(writer.live.mock.calls)).not.toContain("SU1BR0VCWVRFUw==");
    }
  });
});

describe("no screenshot analysis cache", () => {
  const capture = {
    artifactId: "artifact-1",
    url: "http://localhost:3000/",
    width: 800,
    height: 600,
    bytes: 1_024,
    base64: "aGVsbG8=",
    truncated: false,
    durationMs: 10,
  };

  it("calls the vision model again for an identical repeated screenshot question", async () => {
    sessions.screenshot.mockResolvedValue(capture);
    const screenshot = tool("browser_screenshot", false);
    await screenshot.execute("call-1", { question: "Same question" });
    await screenshot.execute("call-2", { question: "Same question" });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(cost.totals().visionRequests).toBe(2);
  });

  it("calls the vision model again for an identical repeated inspect_image request", async () => {
    const image = await writeArtifact("image/png");
    store.getArtifactForChat.mockResolvedValue(image.row);

    const inspect = tool("inspect_image", false);
    await inspect.execute("call-1", { artifactId: image.row.id, question: "Same question" });
    await inspect.execute("call-2", { artifactId: image.row.id, question: "Same question" });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(cost.totals().visionRequests).toBe(2);
  });
});

describe("inspect_image", () => {
  it("analyses a stored screenshot the chat owns", async () => {
    const image = await writeArtifact("image/png");
    store.getArtifactForChat.mockResolvedValue(image.row);

    const outcome = await tool("inspect_image", false).execute("call-1", {
      artifactId: image.row.id,
      question: "Do the cards line up?",
    });

    expect(store.getArtifactForChat).toHaveBeenCalledWith(image.row.id, "chat-1");
    expect((outcome.content[0] as any).text).toContain("The heading is centred.");
    expect(outcome.details).toMatchObject({ artifactId: image.row.id, routing: "delegated", mimeType: "image/png" });
  });

  it("returns the image directly when the run's model reads images", async () => {
    const image = await writeArtifact("image/png");
    store.getArtifactForChat.mockResolvedValue(image.row);

    const outcome = await tool("inspect_image", true).execute("call-1", {
      artifactId: image.row.id,
      question: "Do the cards line up?",
    });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text", "image"]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an artifact that belongs to another chat", async () => {
    store.getArtifactForChat.mockResolvedValue(undefined);
    await expect(
      tool("inspect_image").execute("call-1", {
        artifactId: "11111111-2222-3333-4444-555555555555",
        question: "What is here?",
      }),
    ).rejects.toThrow(/belongs to this chat/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an identifier that is not an artifact id without querying the database", async () => {
    await expect(
      tool("inspect_image").execute("call-1", { artifactId: "../../etc/passwd", question: "What is here?" }),
    ).rejects.toThrow(/belongs to this chat/);
    expect(store.getArtifactForChat).not.toHaveBeenCalled();
  });

  it("rejects a non-image artifact", async () => {
    const artifact = await writeArtifact("application/pdf");
    store.getArtifactForChat.mockResolvedValue(artifact.row);
    await expect(
      tool("inspect_image").execute("call-1", { artifactId: artifact.row.id, question: "What is here?" }),
    ).rejects.toThrow(/not a supported image type/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an artifact with no recorded mime type", async () => {
    const artifact = await writeArtifact(null);
    store.getArtifactForChat.mockResolvedValue(artifact.row);
    await expect(
      tool("inspect_image").execute("call-1", { artifactId: artifact.row.id, question: "What is here?" }),
    ).rejects.toThrow(/not a supported image type/);
  });

  it("rejects an image over the configured size limit", async () => {
    const image = await writeArtifact("image/png");
    store.getArtifactForChat.mockResolvedValue({ ...image.row, size: 20_000_000 });
    await expect(
      tool("inspect_image").execute("call-1", { artifactId: image.row.id, question: "What is here?" }),
    ).rejects.toThrow(/over the 10485760 byte limit/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("never exposes the local storage path when the file is gone", async () => {
    const image = await writeArtifact("image/png");
    store.getArtifactForChat.mockResolvedValue({
      ...image.row,
      storagePath: "/var/secret-place/artifacts/chat-1/missing.png",
    });

    const error = await tool("inspect_image")
      .execute("call-1", { artifactId: image.row.id, question: "What is here?" })
      .catch((thrown: Error) => thrown);

    expect(String(error)).not.toContain("/var/secret-place");
    expect(String(error)).toMatch(/no longer stored/);
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
