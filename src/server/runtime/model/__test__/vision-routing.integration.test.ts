import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VISION_PRIMARY = "google/gemini-3.7-flash";
const TEXT_PRIMARY = "deepseek/deepseek-v4-flash-0731";
const FALLBACK_VISION = "google/gemini-3.7-flash-lite";

const SCREENSHOT_BASE64 = "aVZCT1J3MEtHZ29BQUFBTlNVaEVVZz09";

const sessions = {
  navigate: vi.fn(),
  snapshot: vi.fn(),
  act: vi.fn(),
  screenshot: vi.fn(),
  consoleMessages: vi.fn(),
  close: vi.fn(),
};
vi.mock("../../browser/browser-session.js", () => ({ browserSessions: sessions }));

const store = { getArtifactForChat: vi.fn() };
vi.mock("../../../db/store.js", () => store);

const config = {
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
  BROWSER_NAVIGATION_TIMEOUT_SECONDS: 60,
  VISION_ROUTING_MODE: "auto" as string,
  VISION_MODEL: FALLBACK_VISION,
  VISION_MAX_IMAGE_BYTES: 10_485_760,
  VISION_REQUEST_TIMEOUT_SECONDS: 60,
  VISION_CAPABILITY_CACHE_TTL_SECONDS: 21_600,
  VISION_CAPABILITY_OVERRIDES: {} as Record<string, string>,
};
vi.mock("../../../config.js", () => ({ config }));

const { createBrowserTools } = await import("../../browser/browser-tools.js");
const { createRunVisionRouter } = await import("../vision-router.js");
const { ModelCapabilityService } = await import("../model-capability.js");
const { RunCostAccount } = await import("../run-cost.js");
const { persistedToolSummary, safeToolArguments } = await import("../../output-policy.js");

const openRouterCatalogue = {
  data: [
    {
      id: VISION_PRIMARY,
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.000000375", completion: "0.000001875" },
    },
    {
      id: TEXT_PRIMARY,
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0.0000002", completion: "0.0000008" },
    },
    {
      id: FALLBACK_VISION,
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    },
  ],
};

const analysisJson = JSON.stringify({
  answer: "The heading is centred and no text overflows.",
  observations: ["The header is 64px tall.", "Both cards share 16px padding."],
  visibleText: ["Dashboard", "Sign out"],
  visualProblems: [{ description: "The footer overlaps the table by 4px.", severity: "medium" }],
  confidence: 0.86,
});

const writer = { live: vi.fn() };
let fetchMock: ReturnType<typeof vi.fn>;
let visionModelCalls: Array<{ modelId: string; content: unknown }>;
let complete: ReturnType<typeof vi.fn>;

async function screenshotArtifact() {
  const directory = await mkdtemp(join(tmpdir(), "vision-integration-"));
  const id = randomUUID();
  const storagePath = join(directory, `${id}.png`);
  const contents = Buffer.from(SCREENSHOT_BASE64, "base64");
  await writeFile(storagePath, contents);
  return {
    id,
    sessionId: "chat-1",
    runId: "run-1",
    name: `screenshot-call-1.png`,
    type: "browser_screenshot",
    mimeType: "image/png",
    storagePath,
    size: contents.byteLength,
    metadata: {},
  };
}

function harness(primaryModelId: string) {
  const capabilities = new ModelCapabilityService(fetchMock as never, () => 1_000_000);
  const cost = new RunCostAccount(2);
  return {
    capabilities,
    cost,
    async build() {
      const capability = await capabilities.capabilityOf(primaryModelId);
      const vision = createRunVisionRouter({
        primaryModelId: capability.modelId,
        supportsImages: capability.supportsImages,
        cost,
        complete: complete as never,
        apiKey: () => "test-key",
        capabilities: capabilities as never,
      });
      const tools = createBrowserTools({
        chatId: "chat-1",
        repositoryPath: "/tmp/repo",
        runId: "run-1",
        vision,
        writer,
      });
      return { capability, vision, tools };
    },
  };
}

function tool(tools: Awaited<ReturnType<ReturnType<typeof harness>["build"]>>["tools"], name: string) {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

beforeEach(() => {
  for (const mock of Object.values(sessions)) mock.mockReset();
  writer.live.mockReset();
  store.getArtifactForChat.mockReset();
  config.VISION_ROUTING_MODE = "auto";
  config.VISION_MODEL = FALLBACK_VISION;

  fetchMock = vi.fn(async () => new Response(JSON.stringify(openRouterCatalogue), { status: 200 }));
  visionModelCalls = [];
  complete = vi.fn(async (model: any, context: any) => {
    visionModelCalls.push({ modelId: model.id, content: context.messages[0].content });
    return {
      role: "assistant",
      content: [{ type: "text", text: analysisJson }],
      api: "openai-completions",
      provider: "openrouter",
      model: model.id,
      usage: {
        input: 1_150,
        output: 240,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_390,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000211 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
  });

  sessions.screenshot.mockResolvedValue({
    artifactId: "artifact-1",
    url: "http://localhost:3000/",
    width: 1_280,
    height: 800,
    bytes: 188_416,
    base64: SCREENSHOT_BASE64,
    truncated: false,
    durationMs: 120,
  });
});

describe("vision-capable primary model", () => {
  it("receives the screenshot as an image block and costs no extra request", async () => {
    const run = harness(VISION_PRIMARY);
    const { capability, tools } = await run.build();
    expect(capability).toMatchObject({ supportsImages: true, source: "metadata" });

    const outcome = await tool(tools, "browser_screenshot").execute("call-1", {
      fullPage: true,
      question: "Is the heading centred and is any text overflowing?",
    });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text", "image"]);
    expect(outcome.content[1]).toEqual({ type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" });
    expect((outcome.content[0] as any).text).toContain("Is the heading centred and is any text overflowing?");
    expect(outcome.details).toMatchObject({ routing: "direct", primaryModel: VISION_PRIMARY });

    expect(complete).not.toHaveBeenCalled();
    expect(run.cost.totals()).toMatchObject({ visionRequests: 0, visionCostUsd: 0, costUsd: 0 });
  });

  it("inspects a stored screenshot directly too", async () => {
    const artifact = await screenshotArtifact();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const run = harness(VISION_PRIMARY);
    const { tools } = await run.build();
    const outcome = await tool(tools, "inspect_image").execute("call-2", {
      artifactId: artifact.id,
      question: "Do the two cards have equal padding?",
    });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text", "image"]);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("text-only primary model", () => {
  it("receives fresh fallback text analysis and never an image block", async () => {
    const run = harness(TEXT_PRIMARY);
    const { capability, tools } = await run.build();
    expect(capability).toMatchObject({ supportsImages: false, source: "metadata" });

    const outcome = await tool(tools, "browser_screenshot").execute("call-1", {
      question: "Is anything overlapping?",
    });

    expect(outcome.content.map((block: any) => block.type)).toEqual(["text"]);
    const text = (outcome.content[0] as any).text;
    expect(text).toContain("The heading is centred and no text overflows.");
    expect(text).toContain("The footer overlaps the table by 4px.");
    expect(text).toContain("The header is 64px tall.");
    expect(text).toContain(FALLBACK_VISION);
    expect(text).not.toContain(SCREENSHOT_BASE64);

    expect(visionModelCalls).toHaveLength(1);
    expect(visionModelCalls[0].modelId).toBe(FALLBACK_VISION);
    expect(visionModelCalls[0].content).toEqual([
      { type: "text", text: "Question: Is anything overlapping?" },
      { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" },
    ]);

    expect(outcome.details).toMatchObject({
      routing: "delegated",
      primaryModel: TEXT_PRIMARY,
      visionModel: FALLBACK_VISION,
      structured: true,
      confidence: 0.86,
      visualProblems: 1,
      visionInputTokens: 1_150,
      visionOutputTokens: 240,
    });
    expect(run.cost.totals()).toMatchObject({ visionRequests: 1, inputTokens: 1_150, outputTokens: 240 });
    expect(run.cost.spentUsd()).toBeCloseTo(0.000211);
  });

  it("charges every fallback request to the run budget", async () => {
    const run = harness(TEXT_PRIMARY);
    const { tools } = await run.build();
    const screenshot = tool(tools, "browser_screenshot");

    await screenshot.execute("call-1", { question: "First look" });
    await screenshot.execute("call-2", { question: "Second look" });

    expect(run.cost.totals().visionRequests).toBe(2);
    expect(run.cost.spentUsd()).toBeCloseTo(0.000422);
  });
});

describe("repeated inspection is never served from a cache", () => {
  it("calls the fallback vision model again for an identical repeated inspection", async () => {
    const artifact = await screenshotArtifact();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const run = harness(TEXT_PRIMARY);
    const { tools } = await run.build();
    const inspect = tool(tools, "inspect_image");

    const first = await inspect.execute("call-1", { artifactId: artifact.id, question: "Is it centred?" });
    const second = await inspect.execute("call-2", { artifactId: artifact.id, question: "Is it centred?" });
    const third = await inspect.execute("call-3", { artifactId: artifact.id, question: "Is it centred?" });

    expect(visionModelCalls).toHaveLength(3);
    for (const call of visionModelCalls) {
      expect(call.modelId).toBe(FALLBACK_VISION);
      expect(call.content).toEqual([
        { type: "text", text: "Question: Is it centred?" },
        { type: "image", data: SCREENSHOT_BASE64, mimeType: "image/png" },
      ]);
    }
    expect(run.cost.totals().visionRequests).toBe(3);
    expect((first.content[0] as any).text).toBe((second.content[0] as any).text);
    expect((second.content[0] as any).text).toBe((third.content[0] as any).text);
  });

  it("re-reads the artifact from storage on every inspection", async () => {
    const artifact = await screenshotArtifact();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const run = harness(TEXT_PRIMARY);
    const { tools } = await run.build();
    const inspect = tool(tools, "inspect_image");
    await inspect.execute("call-1", { artifactId: artifact.id, question: "Is it centred?" });
    await inspect.execute("call-2", { artifactId: artifact.id, question: "Is it centred?" });

    expect(store.getArtifactForChat).toHaveBeenCalledTimes(2);
    expect(store.getArtifactForChat).toHaveBeenNthCalledWith(1, artifact.id, "chat-1");
    expect(store.getArtifactForChat).toHaveBeenNthCalledWith(2, artifact.id, "chat-1");
  });
});

describe("provider that advertises image input it cannot serve", () => {
  it("delegates for the rest of the run after the demotion", async () => {
    const run = harness(VISION_PRIMARY);
    const { vision, tools } = await run.build();
    const screenshot = tool(tools, "browser_screenshot");

    const direct = await screenshot.execute("call-1", { question: "First look" });
    expect(direct.details).toMatchObject({ routing: "direct" });
    expect(complete).not.toHaveBeenCalled();

    expect(vision.demoteToTextOnly()).toBe(true);
    expect(vision.takeDirectDeliveries()).toEqual([{ artifactId: "artifact-1", question: "First look" }]);

    const delegated = await screenshot.execute("call-2", { question: "Second look" });
    expect(delegated.content.map((block: any) => block.type)).toEqual(["text"]);
    expect(delegated.details).toMatchObject({ routing: "delegated", visionModel: FALLBACK_VISION });
    expect(visionModelCalls).toHaveLength(1);
  });
});

describe("what reaches Postgres", () => {
  it("persists routing metadata and no image bytes for either route", async () => {
    for (const primaryModelId of [VISION_PRIMARY, TEXT_PRIMARY]) {
      const run = harness(primaryModelId);
      const { tools } = await run.build();
      const args = { fullPage: false, question: "Is the heading centred?" };
      const outcome = await tool(tools, "browser_screenshot").execute("call-1", args);

      const summary = persistedToolSummary({
        toolName: "browser_screenshot",
        isError: false,
        details: outcome.details,
        arguments: safeToolArguments("browser_screenshot", args),
      });

      const serialised = JSON.stringify(summary);
      expect(serialised, primaryModelId).not.toContain(SCREENSHOT_BASE64);
      expect(serialised, primaryModelId).not.toContain("/tmp/");
      expect(summary.data.artifactId, primaryModelId).toBe("artifact-1");
      expect(summary.data.question, primaryModelId).toBe("Is the heading centred?");
      expect(summary.data.primaryModel, primaryModelId).toBe(primaryModelId);
      expect(summary.data.routing, primaryModelId).toBe(
        primaryModelId === VISION_PRIMARY ? "direct" : "delegated",
      );
    }
  });

  it("never puts image bytes or storage paths in a live event", async () => {
    const artifact = await screenshotArtifact();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const run = harness(TEXT_PRIMARY);
    const { tools } = await run.build();
    await tool(tools, "inspect_image").execute("call-1", { artifactId: artifact.id, question: "Is it centred?" });

    const events = JSON.stringify(writer.live.mock.calls);
    expect(events).not.toContain(SCREENSHOT_BASE64);
    expect(events).not.toContain(artifact.storagePath);
  });
});
