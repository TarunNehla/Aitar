/**
 * The models a chat can run on, and how much each one is allowed to think.
 *
 * Levels and their per-model support come from the `reasoning` block OpenRouter
 * publishes for each model, so a level offered here is one the upstream provider
 * accepts. Models whose reasoning is mandatory have no "off".
 */

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface ModelOption {
  id: string;
  label: string;
  /** Accepted levels, weakest first. */
  thinking: readonly ThinkingLevel[];
  defaultThinking: ThinkingLevel;
}

export const modelCatalog: readonly ModelOption[] = [
  {
    id: "z-ai/glm-5.3",
    label: "GLM 5.3",
    thinking: ["low", "high", "max"],
    defaultThinking: "max",
  },
  {
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    thinking: ["low", "high", "max"],
    defaultThinking: "max",
  },
  {
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    thinking: ["low", "medium", "high"],
    defaultThinking: "medium",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    thinking: ["minimal", "low", "medium", "high"],
    defaultThinking: "minimal",
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    thinking: ["off", "low", "high", "max"],
    defaultThinking: "high",
  },
];

export const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Max",
};

export const defaultModelId = "z-ai/glm-5.3-flash";

export function findModel(modelId: string): ModelOption | undefined {
  return modelCatalog.find((option) => option.id === modelId);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingLevels.includes(value as ThinkingLevel);
}

/** Narrows a level read back from storage or an API payload. */
export function asThinkingLevel(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : "medium";
}

/** Levels to offer for a model. An unlisted model keeps every level, since its limits are unknown. */
export function thinkingLevelsFor(modelId: string): readonly ThinkingLevel[] {
  return findModel(modelId)?.thinking ?? thinkingLevels;
}

export function defaultThinkingLevelFor(modelId: string): ThinkingLevel {
  return findModel(modelId)?.defaultThinking ?? "medium";
}

/**
 * The nearest level a model actually accepts, reaching up before down so a request
 * for more thinking is never quietly answered with less. Keeps sessions written
 * against an older catalog — or a model swapped mid-chat — from sending a rejected effort.
 */
export function resolveThinkingLevel(modelId: string, requested: ThinkingLevel): ThinkingLevel {
  const supported = thinkingLevelsFor(modelId);
  if (supported.includes(requested)) return requested;

  const wanted = thinkingLevels.indexOf(requested);
  for (let index = wanted + 1; index < thinkingLevels.length; index++) {
    const level = thinkingLevels[index] as ThinkingLevel;
    if (supported.includes(level)) return level;
  }
  for (let index = wanted - 1; index >= 0; index--) {
    const level = thinkingLevels[index] as ThinkingLevel;
    if (supported.includes(level)) return level;
  }
  return defaultThinkingLevelFor(modelId);
}
