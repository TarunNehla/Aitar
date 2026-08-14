import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = { getArtifactForChat: vi.fn() };
vi.mock("../db/store.js", () => store);

const config = {
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
  VISION_ROUTING_MODE: "auto" as string,
  VISION_MODEL: "vision/observer",
  VISION_MAX_IMAGE_BYTES: 10_485_760,
  VISION_REQUEST_TIMEOUT_SECONDS: 60,
  VISION_CAPABILITY_CACHE_TTL_SECONDS: 21_600,
  VISION_CAPABILITY_OVERRIDES: {} as Record<string, string>,
};
vi.mock("../config.js", () => ({ config }));

const {
  createRunVisionRouter,
  isUnsupportedImageError,
  parseVisionAnalysis,
  recoverFromUnsupportedImage,
  CAPABILITY_FALLBACK_NOTICE,
  DEFAULT_INSPECTION_QUESTION,
  SUPPORTED_IMAGE_MIME_TYPES,
} = await import("./vision-router.js");
const { RunCostAccount } = await import("./run-cost.js");

const image = { base64: "aGVsbG8=", mimeType: "image/png", bytes: 1_024 };
const complete = vi.fn();
const capabilities = { capabilityOf: vi.fn(), costRatesFor: vi.fn(), cachedModalities: vi.fn(), clear: vi.fn() };

function assistant(text: string, costTotal = 0.02, input = 1_000, output = 200, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "vision/observer",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason,
    timestamp: 0,
  };
}

const structured = JSON.stringify({
  answer: "The heading is centred.",
  observations: ["Header is 64px tall.", "Cards share equal padding."],
  visibleText: ["Dashboard", "Sign out"],
  visualProblems: [{ description: "Footer overlaps the table.", severity: "high" }],
  confidence: 0.9,
});

function router(options: { supportsImages?: boolean; maxCostUsd?: number } = {}) {
  const cost = new RunCostAccount(options.maxCostUsd ?? 2);
  const vision = createRunVisionRouter({
    primaryModelId: "primary/model",
    supportsImages: options.supportsImages ?? false,
    cost,
    complete: complete as never,
    apiKey: () => "test-key",
    capabilities: capabilities as never,
  });
  return { vision, cost };
}

beforeEach(() => {
  config.VISION_ROUTING_MODE = "auto";
  config.VISION_MODEL = "vision/observer";
  config.VISION_MAX_IMAGE_BYTES = 10_485_760;
  complete.mockReset();
  store.getArtifactForChat.mockReset();
  capabilities.capabilityOf.mockReset();
  capabilities.costRatesFor.mockReset();
  capabilities.capabilityOf.mockResolvedValue({
    modelId: "vision/observer",
    modalities: ["text", "image"],
    supportsImages: true,
    source: "metadata",
  });
  capabilities.costRatesFor.mockResolvedValue({ input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 });
  complete.mockResolvedValue(assistant(structured));
});

describe("routing decisions", () => {
  it("returns the image for the primary model when it reads images", async () => {
    const { vision, cost } = router({ supportsImages: true });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("direct");
    expect(outcome.image).toEqual(image);
    expect(outcome.text).toBe("Centred?");
    expect(complete).not.toHaveBeenCalled();
    expect(cost.spentUsd()).toBe(0);
  });

  it("delegates when the primary model cannot read images", async () => {
    const { vision } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("delegated");
    expect(outcome.image).toBeUndefined();
    expect(outcome.visionModelId).toBe("vision/observer");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("always delegates in always_delegate mode", async () => {
    config.VISION_ROUTING_MODE = "always_delegate";
    const { vision } = router({ supportsImages: true });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("delegated");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("analyses nothing in disabled mode", async () => {
    config.VISION_ROUTING_MODE = "disabled";
    const { vision, cost } = router({ supportsImages: true });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("disabled");
    expect(outcome.image).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(cost.spentUsd()).toBe(0);
  });

  it("falls back to the default question when none is given", async () => {
    const { vision } = router({ supportsImages: false });
    await vision.inspect({ question: "   ", image });
    expect(JSON.stringify(complete.mock.calls[0][1].messages)).toContain(DEFAULT_INSPECTION_QUESTION);
  });

  it("reports that no vision model is configured rather than failing", async () => {
    config.VISION_MODEL = "";
    const { vision } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("unavailable");
    expect(outcome.text).toContain("browser_snapshot");
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("vision model validation", () => {
  it("refuses to call a configured vision model that cannot read images", async () => {
    capabilities.capabilityOf.mockResolvedValue({
      modelId: "deepseek/deepseek-v4-flash-0731",
      modalities: ["text"],
      supportsImages: false,
      source: "metadata",
    });
    const { vision } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("unavailable");
    expect(outcome.text).toContain("does not report image input support");
    expect(complete).not.toHaveBeenCalled();
  });

  it("validates the vision model only once per run", async () => {
    const { vision } = router({ supportsImages: false });
    await vision.inspect({ question: "One", image });
    await vision.inspect({ question: "Two", image });
    expect(capabilities.capabilityOf).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("builds the vision model with current rates and image input", async () => {
    const { vision } = router({ supportsImages: false });
    await vision.inspect({ question: "Centred?", image });

    const model = complete.mock.calls[0][0];
    expect(model).toMatchObject({
      id: "vision/observer",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      input: ["text", "image"],
      cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe("image validation", () => {
  it("rejects an image over the configured limit", async () => {
    const { vision } = router({ supportsImages: false });
    await expect(
      vision.inspect({ question: "Centred?", image: { ...image, bytes: 20_000_000 } }),
    ).rejects.toThrow(/over the 10485760 byte limit/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an unsupported mime type", async () => {
    const { vision } = router({ supportsImages: false });
    await expect(
      vision.inspect({ question: "Centred?", image: { ...image, mimeType: "application/pdf" } }),
    ).rejects.toThrow(/not a supported image type/);
  });

  it("rejects an oversized image before the direct route too", async () => {
    const { vision } = router({ supportsImages: true });
    await expect(
      vision.inspect({ question: "Centred?", image: { ...image, bytes: 20_000_000 } }),
    ).rejects.toThrow(/byte limit/);
  });

  it("accepts the supported image types", () => {
    expect([...SUPPORTED_IMAGE_MIME_TYPES].sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
  });
});

describe("run budget", () => {
  it("charges the delegated request to the run", async () => {
    const { vision, cost } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.usage).toEqual({ inputTokens: 1_000, outputTokens: 200, costUsd: 0.02 });
    expect(cost.spentUsd()).toBeCloseTo(0.02);
    expect(cost.totals()).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 200,
      visionCostUsd: 0.02,
      visionRequests: 1,
    });
  });

  it("does not start a request when the remaining budget is too small", async () => {
    const { vision, cost } = router({ supportsImages: false, maxCostUsd: 0.5 });
    cost.addModelUsage({ input: 10, output: 10, cost: { total: 0.499 } });

    const outcome = await vision.inspect({ question: "Centred?", image });
    expect(outcome.decision).toBe("budget_exhausted");
    expect(complete).not.toHaveBeenCalled();
    expect(cost.totals().visionRequests).toBe(0);
  });

  it("still runs when the remaining budget is sufficient", async () => {
    const { vision, cost } = router({ supportsImages: false, maxCostUsd: 2 });
    cost.addModelUsage({ input: 10, output: 10, cost: { total: 1 } });

    const outcome = await vision.inspect({ question: "Centred?", image });
    expect(outcome.decision).toBe("delegated");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("adds every delegated request to the run total", async () => {
    const { vision, cost } = router({ supportsImages: false });
    await vision.inspect({ question: "One", image });
    await vision.inspect({ question: "Two", image });
    expect(cost.totals().visionRequests).toBe(2);
    expect(cost.spentUsd()).toBeCloseTo(0.04);
  });
});

describe("structured response parsing", () => {
  it("parses the documented response shape", () => {
    const analysis = parseVisionAnalysis(structured);
    expect(analysis).toEqual({
      answer: "The heading is centred.",
      observations: ["Header is 64px tall.", "Cards share equal padding."],
      visibleText: ["Dashboard", "Sign out"],
      visualProblems: [{ description: "Footer overlaps the table.", severity: "high" }],
      confidence: 0.9,
    });
  });

  it("reads json wrapped in prose or a fenced block", () => {
    expect(parseVisionAnalysis(`Sure!\n\`\`\`json\n${structured}\n\`\`\`\nHope that helps.`)).toMatchObject({
      answer: "The heading is centred.",
    });
  });

  it("clamps confidence into range and defaults an unknown severity to low", () => {
    const analysis = parseVisionAnalysis(
      JSON.stringify({
        answer: "ok",
        visualProblems: [{ description: "odd", severity: "catastrophic" }],
        confidence: 7.5,
      }),
    );
    expect(analysis?.confidence).toBe(1);
    expect(analysis?.visualProblems[0].severity).toBe("low");
  });

  it("returns null for malformed or empty payloads", () => {
    for (const raw of ["", "not json at all", "{", "{}", "[1,2,3]", '{"answer": ""}']) {
      expect(parseVisionAnalysis(raw), raw).toBeNull();
    }
  });

  it("returns bounded text when the vision model does not answer with json", async () => {
    complete.mockResolvedValue(assistant("The page looks fine to me, nothing overlaps."));
    const { vision, cost } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });

    expect(outcome.decision).toBe("delegated");
    expect(outcome.structured).toBe(false);
    expect(outcome.analysis).toBeUndefined();
    expect(outcome.text).toContain("The page looks fine to me");
    expect(outcome.text).toContain("unstructured");
    expect(cost.totals().visionRequests).toBe(1);
  });

  it("bounds a very long unstructured answer", async () => {
    complete.mockResolvedValue(assistant("z".repeat(10_000)));
    const { vision } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });
    expect(outcome.text.length).toBeLessThan(2_200);
  });

  it("reports an empty response without throwing", async () => {
    complete.mockResolvedValue(assistant(""));
    const { vision } = router({ supportsImages: false });
    const outcome = await vision.inspect({ question: "Centred?", image });
    expect(outcome.text).toContain("no readable analysis");
  });

  it("raises the provider error when the request fails", async () => {
    complete.mockResolvedValue({ ...assistant("", 0, 0, 0, "error"), errorMessage: "upstream exploded" });
    const { vision } = router({ supportsImages: false });
    await expect(vision.inspect({ question: "Centred?", image })).rejects.toThrow(/upstream exploded/);
  });
});

describe("observer prompt", () => {
  it("forbids code changes and command selection", async () => {
    const { vision } = router({ supportsImages: false });
    await vision.inspect({ question: "Centred?", image });
    const prompt = complete.mock.calls[0][1].systemPrompt as string;

    expect(prompt).toContain("Report only what is visible");
    expect(prompt).toMatch(/must not suggest shell commands, patches, or file edits/);
    expect(prompt).toContain("cannot browse, run commands, or change code");
  });

  it("forbids transcribing a visible credential", async () => {
    const { vision } = router({ supportsImages: false });
    await vision.inspect({ question: "Centred?", image });
    const prompt = complete.mock.calls[0][1].systemPrompt as string;

    expect(prompt).toMatch(/Never transcribe a password, token, API key, one-time code, or card number/);
    expect(prompt).toContain("[redacted]");
  });
});

describe("recovering from a provider that cannot serve image input", () => {
  async function storedScreenshot() {
    const directory = await mkdtemp(join(tmpdir(), "vision-recover-"));
    const id = randomUUID();
    const storagePath = join(directory, `${id}.png`);
    await writeFile(storagePath, "screenshot-bytes");
    return {
      id,
      sessionId: "chat-1",
      name: "screenshot.png",
      type: "browser_screenshot",
      mimeType: "image/png",
      storagePath,
      size: 16,
      metadata: {},
    };
  }

  function recovery(vision: ReturnType<typeof createRunVisionRouter>, errorMessage: string | undefined) {
    const emit = vi.fn(async (_type: string, _payload: Record<string, unknown>) => undefined);
    const steer = vi.fn((_text: string) => undefined);
    return {
      emit,
      steer,
      run: () => recoverFromUnsupportedImage({ errorMessage, vision, chatId: "chat-1", emit, steer }),
    };
  }

  it("demotes, emits a safe event, re-analyses the screenshot, and steers the analysis back", async () => {
    const artifact = await storedScreenshot();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const { vision } = router({ supportsImages: true });
    vision.recordDirectDelivery({ artifactId: artifact.id, question: "Is the heading centred?" });

    const attempt = recovery(vision, "This model does not support image input");
    expect(await attempt.run()).toBe(true);

    expect(vision.supportsImages()).toBe(false);
    expect(attempt.emit).toHaveBeenCalledWith("vision_capability_fallback", {
      model: "primary/model",
      reason: "image_input_unsupported",
    });
    expect(complete).toHaveBeenCalledTimes(1);

    const steered = attempt.steer.mock.calls[0][0] as string;
    expect(steered).toContain(CAPABILITY_FALLBACK_NOTICE);
    expect(steered).toContain("The heading is centred.");
    expect(steered).not.toContain(image.base64);
  });

  it("emits a payload with no image bytes, prompt, or storage path", async () => {
    const artifact = await storedScreenshot();
    store.getArtifactForChat.mockResolvedValue(artifact);

    const { vision } = router({ supportsImages: true });
    vision.recordDirectDelivery({ artifactId: artifact.id, question: "Is the heading centred?" });

    const attempt = recovery(vision, "no endpoints found that support image input");
    await attempt.run();

    const payload = JSON.stringify(attempt.emit.mock.calls[0][1]);
    expect(payload).not.toContain(artifact.storagePath);
    expect(payload).not.toContain("screenshot-bytes");
    expect(payload).not.toContain("Is the heading centred?");
  });

  it("does not demote for an unrelated failure", async () => {
    for (const message of [
      "401 Unauthorized",
      "429 rate limit exceeded",
      "Request timed out",
      "503 Service Unavailable",
      "The run exceeded its budget",
      undefined,
    ]) {
      const { vision } = router({ supportsImages: true });
      const attempt = recovery(vision, message);
      expect(await attempt.run(), String(message)).toBe(false);
      expect(vision.supportsImages(), String(message)).toBe(true);
      expect(attempt.emit).not.toHaveBeenCalled();
      expect(attempt.steer).not.toHaveBeenCalled();
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not demote a second time, so the direct route is never retried in a loop", async () => {
    const { vision } = router({ supportsImages: true });
    const first = recovery(vision, "This model does not support image input");
    expect(await first.run()).toBe(true);

    const second = recovery(vision, "This model does not support image input");
    expect(await second.run()).toBe(false);
    expect(second.emit).not.toHaveBeenCalled();
  });

  it("still steers the notice when the screenshot can no longer be re-analysed", async () => {
    store.getArtifactForChat.mockResolvedValue(undefined);

    const { vision } = router({ supportsImages: true });
    vision.recordDirectDelivery({ artifactId: randomUUID(), question: "Is the heading centred?" });

    const attempt = recovery(vision, "This model does not support image input");
    expect(await attempt.run()).toBe(true);
    expect(attempt.steer.mock.calls[0][0]).toBe(CAPABILITY_FALLBACK_NOTICE);
  });

  it("demotes even when no screenshot was delivered directly", async () => {
    const { vision } = router({ supportsImages: true });
    const attempt = recovery(vision, "image_url is not supported");
    expect(await attempt.run()).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(attempt.steer).toHaveBeenCalledTimes(1);
  });
});

describe("a screenshot survives a failed analysis", () => {
  it("reports the failure as unavailable rather than throwing", async () => {
    complete.mockRejectedValue(new Error("upstream is down"));
    const { vision } = router({ supportsImages: false });
    await expect(vision.inspect({ question: "Centred?", image })).rejects.toThrow(/upstream is down/);
  });
});

describe("unsupported image classification", () => {
  it("recognises a provider refusing image input", () => {
    for (const message of [
      "This model does not support image input",
      "google/x doesn't support images",
      "No endpoints found that support image input",
      "image_url is not supported by this model",
      "Vision is not supported for this deployment",
    ]) {
      expect(isUnsupportedImageError(message), message).toBe(true);
    }
  });

  it("does not treat unrelated failures as a capability problem", () => {
    for (const message of [
      "401 Unauthorized: invalid api key",
      "429 rate limit exceeded",
      "Request timed out after 60s",
      "503 Service Unavailable",
      "502 Bad Gateway",
      "Insufficient credit to serve this request",
      "The run exceeded its budget",
      "aborted by the user",
      "",
      undefined,
    ]) {
      expect(isUnsupportedImageError(message), String(message)).toBe(false);
    }
  });

  it("prefers the unrelated classification when both signals appear", () => {
    expect(isUnsupportedImageError("429 rate limit: model does not support image input right now")).toBe(false);
  });
});

describe("capability demotion", () => {
  it("routes to the vision model for the rest of the run after a demotion", async () => {
    const { vision } = router({ supportsImages: true });
    expect(vision.supportsImages()).toBe(true);

    expect(vision.demoteToTextOnly()).toBe(true);
    expect(vision.supportsImages()).toBe(false);
    expect(vision.wasDemoted()).toBe(true);

    const outcome = await vision.inspect({ question: "Centred?", image });
    expect(outcome.decision).toBe("delegated");
  });

  it("demotes only once so the direct route is not retried repeatedly", () => {
    const { vision } = router({ supportsImages: true });
    expect(vision.demoteToTextOnly()).toBe(true);
    expect(vision.demoteToTextOnly()).toBe(false);
    expect(vision.demoteToTextOnly()).toBe(false);
  });

  it("tracks direct deliveries by identifier only and drains them once", async () => {
    const { vision } = router({ supportsImages: true });
    vision.recordDirectDelivery({ artifactId: "artifact-1", question: "Centred?" });
    vision.recordDirectDelivery({ artifactId: "artifact-2", question: "Overflowing?" });

    const drained = vision.takeDirectDeliveries();
    expect(drained).toEqual([
      { artifactId: "artifact-1", question: "Centred?" },
      { artifactId: "artifact-2", question: "Overflowing?" },
    ]);
    expect(JSON.stringify(drained)).not.toContain(image.base64);
    expect(vision.takeDirectDeliveries()).toEqual([]);
  });

  it("keeps only the most recent direct deliveries", () => {
    const { vision } = router({ supportsImages: true });
    for (let index = 0; index < 6; index += 1) {
      vision.recordDirectDelivery({ artifactId: `artifact-${index}`, question: "Centred?" });
    }
    const drained = vision.takeDirectDeliveries();
    expect(drained).toHaveLength(3);
    expect(drained.map((entry) => entry.artifactId)).toEqual(["artifact-3", "artifact-4", "artifact-5"]);
  });
});
