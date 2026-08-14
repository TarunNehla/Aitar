import { beforeEach, describe, expect, it, vi } from "vitest";

const config = {
  LOG_LEVEL: "silent",
  LOG_PRETTY: false,
  NODE_ENV: "test",
  VISION_CAPABILITY_CACHE_TTL_SECONDS: 21_600,
  VISION_REQUEST_TIMEOUT_SECONDS: 60,
  VISION_CAPABILITY_OVERRIDES: {} as Record<string, string>,
};
vi.mock("../config.js", () => ({ config }));

const { ModelCapabilityService, normaliseModelId } = await import("./model-capability.js");

const catalogue = {
  data: [
    {
      id: "google/gemini-3.7-flash",
      architecture: { input_modalities: ["text", "image", "audio"] },
      pricing: { prompt: "0.000000375", completion: "0.000001875", input_cache_read: "0.0000000375" },
    },
    {
      id: "deepseek/deepseek-v4-flash-0731",
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0.0000002", completion: "0.0000008" },
    },
    { id: "openrouter/auto", architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0" } },
    { id: "weird/no-modalities", architecture: {}, pricing: { prompt: "0.000001" } },
    {
      id: "google/gemini-3.7-flash:batch",
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.0000001875", completion: "0.0000009375" },
    },
    {
      id: "some/model:free",
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0" },
    },
  ],
};

let now = 1_000_000;
let fetchMock: ReturnType<typeof vi.fn>;

function service() {
  return new ModelCapabilityService(fetchMock as never, () => now);
}

beforeEach(() => {
  now = 1_000_000;
  config.VISION_CAPABILITY_OVERRIDES = {};
  config.VISION_CAPABILITY_CACHE_TTL_SECONDS = 21_600;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(catalogue), { status: 200 }));
});

describe("model id normalisation", () => {
  it("lowercases, trims, and drops the provider variant suffix", () => {
    expect(normaliseModelId("  Google/Gemini-3.7-Flash  ")).toBe("google/gemini-3.7-flash");
    expect(normaliseModelId("google/gemini-3.7-flash:free")).toBe("google/gemini-3.7-flash");
    expect(normaliseModelId("google/gemini-3.7-flash:nitro")).toBe("google/gemini-3.7-flash");
    expect(normaliseModelId(undefined)).toBe("");
  });
});

describe("image capability detection", () => {
  it("reports image support from architecture.input_modalities", async () => {
    const capability = await service().capabilityOf("google/gemini-3.7-flash");
    expect(capability).toEqual({
      modelId: "google/gemini-3.7-flash",
      modalities: ["text", "image"],
      supportsImages: true,
      source: "metadata",
    });
  });

  it("reports a text-only model as text-only", async () => {
    const capability = await service().capabilityOf("deepseek/deepseek-v4-flash-0731");
    expect(capability.supportsImages).toBe(false);
    expect(capability.modalities).toEqual(["text"]);
    expect(capability.source).toBe("metadata");
  });

  it("resolves a variant suffix to the base model's modalities", async () => {
    const capability = await service().capabilityOf("google/gemini-3.7-flash:free");
    expect(capability.supportsImages).toBe(true);
  });

  it("prefers a variant's own entry over the base entry when it is listed", async () => {
    const capability = await service().capabilityOf("some/model:free");
    expect(capability.modalities).toEqual(["text"]);
    expect(capability.supportsImages).toBe(false);
  });

  it("caches a variant separately from its base model", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash:batch");
    expect(capabilities.cachedModalities("google/gemini-3.7-flash:batch")).toEqual(["text", "image"]);
    expect(capabilities.cachedModalities("google/gemini-3.7-flash")).toBeNull();
  });

  it("treats a model missing from the metadata as text-only and unknown", async () => {
    const capability = await service().capabilityOf("someone/never-published");
    expect(capability).toEqual({
      modelId: "someone/never-published",
      modalities: null,
      supportsImages: false,
      source: "unknown",
    });
  });

  it("treats a dynamic router as unknown even though it advertises images", async () => {
    const capability = await service().capabilityOf("openrouter/auto");
    expect(capability.supportsImages).toBe(false);
    expect(capability.source).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a model with no declared modalities as unknown", async () => {
    const capability = await service().capabilityOf("weird/no-modalities");
    expect(capability.supportsImages).toBe(false);
    expect(capability.source).toBe("unknown");
  });

  it("treats an empty model id as unknown", async () => {
    const capability = await service().capabilityOf("");
    expect(capability.supportsImages).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never guesses from the model name", async () => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    for (const id of ["google/gemini-vision-pro", "openai/gpt-4-vision", "anything/multimodal-image"]) {
      const capability = await service().capabilityOf(id);
      expect(capability.supportsImages, id).toBe(false);
    }
  });

  it("treats an unavailable metadata endpoint as unknown rather than image-capable", async () => {
    fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    const capability = await service().capabilityOf("google/gemini-3.7-flash");
    expect(capability.supportsImages).toBe(false);
    expect(capability.source).toBe("unknown");
  });

  it("treats a network failure as unknown", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const capability = await service().capabilityOf("google/gemini-3.7-flash");
    expect(capability.supportsImages).toBe(false);
  });
});

describe("capability cache", () => {
  it("queries OpenRouter once for repeated lookups of the same model", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent lookups", async () => {
    const capabilities = service();
    await Promise.all([
      capabilities.capabilityOf("google/gemini-3.7-flash"),
      capabilities.capabilityOf("deepseek/deepseek-v4-flash-0731"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds only model ids and modalities", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    expect(capabilities.cachedModalities("google/gemini-3.7-flash")).toEqual(["text", "image"]);
    expect(JSON.stringify(capabilities.cachedModalities("google/gemini-3.7-flash"))).not.toContain("0.000000375");
  });

  it("re-queries once the entry expires", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += config.VISION_CAPABILITY_CACHE_TTL_SECONDS * 1_000 + 1;
    expect(capabilities.cachedModalities("google/gemini-3.7-flash")).toBeNull();

    await capabilities.capabilityOf("google/gemini-3.7-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an entry until the ttl elapses", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    now += config.VISION_CAPABILITY_CACHE_TTL_SECONDS * 1_000 - 1;
    expect(capabilities.cachedModalities("google/gemini-3.7-flash")).toEqual(["text", "image"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a model it could not resolve", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("someone/never-published");
    expect(capabilities.cachedModalities("someone/never-published")).toBeNull();
  });

  it("clears on request", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    capabilities.clear();
    expect(capabilities.cachedModalities("google/gemini-3.7-flash")).toBeNull();
  });
});

describe("manual capability overrides", () => {
  it("forces image support on", async () => {
    config.VISION_CAPABILITY_OVERRIDES = { "deepseek/deepseek-v4-flash-0731": "image" };
    const capability = await service().capabilityOf("deepseek/deepseek-v4-flash-0731");
    expect(capability).toEqual({
      modelId: "deepseek/deepseek-v4-flash-0731",
      modalities: ["text", "image"],
      supportsImages: true,
      source: "override",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces image support off for a model the metadata says is multimodal", async () => {
    config.VISION_CAPABILITY_OVERRIDES = { "google/gemini-3.7-flash": "text" };
    const capability = await service().capabilityOf("google/gemini-3.7-flash");
    expect(capability.supportsImages).toBe(false);
    expect(capability.source).toBe("override");
  });

  it("overrides a dynamic router that is otherwise unknown", async () => {
    config.VISION_CAPABILITY_OVERRIDES = { "openrouter/auto": "image" };
    const capability = await service().capabilityOf("openrouter/auto");
    expect(capability.supportsImages).toBe(true);
    expect(capability.source).toBe("override");
  });
});

describe("cost rates", () => {
  it("converts per-token OpenRouter prices to per-million-token rates", async () => {
    const rates = await service().costRatesFor("google/gemini-3.7-flash");
    expect(rates).toEqual({ input: 0.375, output: 1.875, cacheRead: 0.0375, cacheWrite: 0 });
  });

  it("returns null for a model it cannot find", async () => {
    expect(await service().costRatesFor("someone/never-published")).toBeNull();
  });

  it("prices the exact model rather than a cheaper variant that shares its base id", async () => {
    const rates = await service().costRatesFor("google/gemini-3.7-flash");
    expect(rates).toMatchObject({ input: 0.375, output: 1.875 });
  });

  it("prices a variant from its own entry when one is configured", async () => {
    const rates = await service().costRatesFor("google/gemini-3.7-flash:batch");
    expect(rates).toMatchObject({ input: 0.1875, output: 0.9375 });
  });

  it("falls back to the base entry for a variant OpenRouter does not list separately", async () => {
    const rates = await service().costRatesFor("google/gemini-3.7-flash:nitro");
    expect(rates).toMatchObject({ input: 0.375, output: 1.875 });
  });

  it("is not served from the capability cache", async () => {
    const capabilities = service();
    await capabilities.capabilityOf("google/gemini-3.7-flash");
    await capabilities.costRatesFor("google/gemini-3.7-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
