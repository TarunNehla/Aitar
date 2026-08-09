import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyProviderRouting,
  configuredProviderPreferences,
  providerPreferences,
} from "./openrouter-routing.js";

const openrouterModel = { id: "deepseek/deepseek-v4-flash-0731", provider: "openrouter" } as Model<Api>;
const otherModel = { id: "gpt-5", provider: "openai" } as Model<Api>;

describe("OpenRouter provider routing", () => {
  it("pins requests to the configured providers when fallbacks are off", () => {
    expect(providerPreferences(["baseten"], false)).toEqual({ only: ["baseten"], allow_fallbacks: false });
  });

  it("treats the list as a preference order when fallbacks are allowed", () => {
    expect(providerPreferences(["baseten", "fireworks"], true))
      .toEqual({ order: ["baseten", "fireworks"], allow_fallbacks: true });
  });

  it("leaves routing to OpenRouter when no provider is configured", () => {
    expect(providerPreferences([], false)).toBeNull();
    expect(providerPreferences([], true)).toBeNull();
  });

  it("configures no preference by default, leaving routing to OpenRouter", () => {
    expect(configuredProviderPreferences()).toBeNull();
  });

  it("leaves the request body untouched when no provider is configured", () => {
    const payload = { model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] };

    expect(applyProviderRouting(payload, openrouterModel)).toBeUndefined();
    expect(payload).not.toHaveProperty("provider");
  });

  it("leaves payloads for other providers unchanged", () => {
    expect(applyProviderRouting({ model: "gpt-5" }, otherModel)).toBeUndefined();
  });
});
