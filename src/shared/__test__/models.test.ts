import { describe, expect, it } from "vitest";
import {
  defaultModelId,
  defaultThinkingLevelFor,
  findModel,
  modelCatalog,
  resolveThinkingLevel,
  thinkingLevels,
  thinkingLevelsFor,
  type ThinkingLevel,
} from "../models";

describe("model catalog", () => {
  it("offers only OpenRouter ids", () => {
    for (const option of modelCatalog) expect(option.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.\-]+$/);
  });

  it("has a default that is itself on offer", () => {
    expect(findModel(defaultModelId)).toBeDefined();
  });

  it("gives every model a default it actually accepts", () => {
    for (const option of modelCatalog) {
      expect(option.thinking).not.toHaveLength(0);
      expect(option.thinking).toContain(option.defaultThinking);
    }
  });

  it("orders each model's levels weakest first", () => {
    for (const option of modelCatalog) {
      const positions = option.thinking.map((level) => thinkingLevels.indexOf(level));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe("resolveThinkingLevel", () => {
  it("keeps a level the model accepts", () => {
    expect(resolveThinkingLevel("google/gemini-3.8-flash", "medium")).toBe("medium");
  });

  it("reaches up rather than down, so more thinking is never answered with less", () => {
    // GLM offers low/high/max, so "medium" has to land on "high".
    expect(resolveThinkingLevel("z-ai/glm-5.3", "medium")).toBe("high");
    expect(resolveThinkingLevel("z-ai/glm-5.3-flash", "minimal")).toBe("low");
  });

  it("steps down only when nothing stronger exists", () => {
    expect(resolveThinkingLevel("google/gemini-3.8-flash", "max")).toBe("high");
  });

  it("turns off into the weakest level a mandatory-reasoning model allows", () => {
    expect(resolveThinkingLevel("google/gemini-3.5-flash-lite", "off")).toBe("minimal");
    expect(resolveThinkingLevel("z-ai/glm-5.3", "off")).toBe("low");
  });

  it("leaves off alone where the model can disable reasoning", () => {
    expect(resolveThinkingLevel("deepseek/deepseek-v4-flash-0731", "off")).toBe("off");
  });

  it("passes any level through for a model outside the catalog", () => {
    for (const level of thinkingLevels) expect(resolveThinkingLevel("legacy/model", level)).toBe(level);
  });

  it("never returns a level the model rejects, whatever it is asked for", () => {
    for (const option of modelCatalog) {
      for (const level of thinkingLevels) {
        expect(option.thinking).toContain(resolveThinkingLevel(option.id, level));
      }
    }
  });
});

describe("per-model level lists", () => {
  it("matches the catalog for a known model", () => {
    expect(thinkingLevelsFor("deepseek/deepseek-v4-flash-0731")).toEqual(["off", "low", "high", "max"]);
    expect(defaultThinkingLevelFor("deepseek/deepseek-v4-flash-0731")).toBe("high");
  });

  it("keeps every level for an unknown model, since its limits are unknown", () => {
    expect(thinkingLevelsFor("legacy/model")).toEqual(thinkingLevels);
    expect(defaultThinkingLevelFor("legacy/model")).toBe("medium" satisfies ThinkingLevel);
  });
});
