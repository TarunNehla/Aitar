import { readFile } from "node:fs/promises";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import { getArtifactForChat } from "../db/store.js";
import { errorForLog, logger } from "../logger.js";
import { modelCapabilities, type ModelCapabilityService, type ModelCostRates } from "./model-capability.js";
import type { RunCostAccount, VisionCharge } from "./run-cost.js";

export const DEFAULT_INSPECTION_QUESTION =
  "Describe the visible layout and identify obvious visual problems.";

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const OBSERVER_PROMPT = [
  "You are a visual observer for a coding agent. You are shown one screenshot of a web page.",
  "Report only what is visible in the image. You cannot browse, run commands, or change code,",
  "and you must not suggest shell commands, patches, or file edits.",
  "Do not guess at implementation details, frameworks, or source files.",
  "Never transcribe a password, token, API key, one-time code, or card number, even when it is legible.",
  "Write [redacted] in its place and say where it appeared.",
  "",
  "Reply with a single JSON object and nothing else:",
  '{"answer": string, "observations": string[], "visibleText": string[],',
  ' "visualProblems": [{"description": string, "severity": "low"|"medium"|"high"}],',
  ' "confidence": number between 0 and 1}',
  "",
  "answer responds to the question directly. observations are short factual notes about layout,",
  "spacing, alignment, colour, and overlap. visibleText quotes text you can actually read.",
  "visualProblems lists only problems visible in the image. Use an empty array when there are none.",
].join("\n");

const ANSWER_LIMIT = 2_000;
const LIST_ITEM_LIMIT = 240;
const MAX_LIST_ITEMS = 12;
const FALLBACK_TEXT_LIMIT = 2_000;
const VISION_MAX_TOKENS = 1_200;

const ESTIMATED_IMAGE_INPUT_TOKENS = 2_000;
const ESTIMATED_OUTPUT_TOKENS = 900;
const MINIMUM_BUDGET_USD = 0.01;

export type RoutingDecision = "direct" | "delegated" | "disabled" | "unavailable" | "budget_exhausted";

export interface VisualProblem {
  description: string;
  severity: "low" | "medium" | "high";
}

export interface VisionAnalysis {
  answer: string;
  observations: string[];
  visibleText: string[];
  visualProblems: VisualProblem[];
  confidence: number;
}

export interface VisionImage {
  base64: string;
  mimeType: string;
  bytes: number;
}

export interface VisionOutcome {
  decision: RoutingDecision;
  text: string;
  image?: VisionImage;
  analysis?: VisionAnalysis;
  structured: boolean;
  visionModelId?: string;
  usage?: VisionCharge;
  durationMs: number;
}

export type CompleteFunction = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

const UNSUPPORTED_IMAGE_PATTERNS = [
  /does\s+not\s+support\s+image/i,
  /doesn'?t\s+support\s+image/i,
  /no\s+endpoints\s+found\s+that\s+support\s+image/i,
  /image\s+input\s+is\s+not\s+supported/i,
  /image[_\s-]?url\s+is\s+not\s+supported/i,
  /unsupported\s+content\s+type.*image/i,
  /modality.*image.*not\s+supported/i,
  /vision\s+is\s+not\s+supported/i,
];

const UNRELATED_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /quota/i,
  /insufficient\s+(?:credit|funds|balance)/i,
  /unauthor(?:ized|ised)/i,
  /authentication/i,
  /invalid\s+api\s+key/i,
  /forbidden/i,
  /timed?\s*out/i,
  /timeout/i,
  /aborted/i,
  /service\s+unavailable/i,
  /bad\s+gateway/i,
  /internal\s+server\s+error/i,
  /overloaded/i,
  /budget/i,
];

export function isUnsupportedImageError(message: unknown): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  if (UNRELATED_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return UNSUPPORTED_IMAGE_PATTERNS.some((pattern) => pattern.test(text));
}

function boundedText(value: unknown, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function boundedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => boundedText(entry, LIST_ITEM_LIMIT))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function boundedProblems(value: unknown): VisualProblem[] {
  if (!Array.isArray(value)) return [];
  const problems: VisualProblem[] = [];
  for (const entry of value.slice(0, MAX_LIST_ITEMS)) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const description = boundedText(record.description ?? entry, LIST_ITEM_LIMIT);
    if (!description) continue;
    const severity = String(record.severity ?? "").toLowerCase();
    problems.push({
      description,
      severity: severity === "high" || severity === "medium" ? severity : "low",
    });
  }
  return problems;
}

function boundedConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function parseVisionAnalysis(raw: string): VisionAnalysis | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  const analysis: VisionAnalysis = {
    answer: boundedText(record.answer, ANSWER_LIMIT),
    observations: boundedList(record.observations),
    visibleText: boundedList(record.visibleText),
    visualProblems: boundedProblems(record.visualProblems),
    confidence: boundedConfidence(record.confidence),
  };
  const empty =
    !analysis.answer &&
    analysis.observations.length === 0 &&
    analysis.visibleText.length === 0 &&
    analysis.visualProblems.length === 0;
  return empty ? null : analysis;
}

export function renderAnalysis(analysis: VisionAnalysis, visionModelId: string): string {
  const lines = [`Visual analysis of the screenshot (inspected by ${visionModelId}):`, ""];
  if (analysis.answer) lines.push(analysis.answer, "");
  if (analysis.observations.length > 0) {
    lines.push("Observations:", ...analysis.observations.map((entry) => `- ${entry}`), "");
  }
  if (analysis.visibleText.length > 0) {
    lines.push("Visible text:", ...analysis.visibleText.map((entry) => `- ${entry}`), "");
  }
  lines.push(
    analysis.visualProblems.length > 0 ? "Visual problems:" : "Visual problems: none reported.",
    ...analysis.visualProblems.map((problem) => `- [${problem.severity}] ${problem.description}`),
  );
  lines.push("", `Reported confidence: ${analysis.confidence.toFixed(2)}.`);
  return lines.join("\n").trim();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactNotAvailableError extends Error {}

export async function loadImageArtifact(input: {
  artifactId: string;
  chatId: string;
}): Promise<VisionImage & { name: string }> {
  const artifactId = String(input.artifactId ?? "").trim();
  const missing = new ArtifactNotAvailableError(`No image artifact ${artifactId || "(none)"} belongs to this chat.`);
  if (!UUID_PATTERN.test(artifactId)) throw missing;

  const artifact = await getArtifactForChat(artifactId, input.chatId);
  if (!artifact) throw missing;

  const mimeType = String(artifact.mimeType ?? "").trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new ArtifactNotAvailableError(
      `Artifact ${artifactId} is ${mimeType || "an unknown type"}, which is not a supported image type.`,
    );
  }
  if (artifact.size > config.VISION_MAX_IMAGE_BYTES) {
    throw new ArtifactNotAvailableError(
      `Artifact ${artifactId} is ${artifact.size} bytes, over the ${config.VISION_MAX_IMAGE_BYTES} byte limit for visual analysis.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.storagePath);
  } catch (error) {
    logger.child({ component: "vision-router" }).warn(
      { error: errorForLog(error), artifactId },
      "Image artifact could not be read from storage",
    );
    throw new ArtifactNotAvailableError(`Artifact ${artifactId} is no longer stored on this deployment.`);
  }
  if (bytes.byteLength > config.VISION_MAX_IMAGE_BYTES) {
    throw new ArtifactNotAvailableError(
      `Artifact ${artifactId} is ${bytes.byteLength} bytes, over the ${config.VISION_MAX_IMAGE_BYTES} byte limit for visual analysis.`,
    );
  }
  return {
    base64: bytes.toString("base64"),
    mimeType,
    bytes: bytes.byteLength,
    name: String(artifact.name ?? "image"),
  };
}

export interface RunVisionRouterOptions {
  primaryModelId: string;
  supportsImages: boolean;
  cost: RunCostAccount;
  complete: CompleteFunction;
  apiKey: () => string | undefined;
  capabilities?: ModelCapabilityService;
  onPayload?: SimpleStreamOptions["onPayload"];
}

const MAX_TRACKED_DIRECT_DELIVERIES = 3;

export class RunVisionRouter {
  private readonly capabilities: ModelCapabilityService;
  private readonly directDeliveries: Array<{ artifactId: string; question: string }> = [];
  private demoted = false;
  private visionModel: Model<any> | null = null;
  private visionModelChecked = false;
  private readonly log = logger.child({ component: "vision-router" });

  constructor(private readonly options: RunVisionRouterOptions) {
    this.capabilities = options.capabilities ?? modelCapabilities;
  }

  get primaryModelId(): string {
    return this.options.primaryModelId;
  }

  supportsImages(): boolean {
    return this.options.supportsImages && !this.demoted;
  }

  wasDemoted(): boolean {
    return this.demoted;
  }

  demoteToTextOnly(): boolean {
    if (this.demoted) return false;
    this.demoted = true;
    return true;
  }

  recordDirectDelivery(entry: { artifactId: string; question: string }): void {
    this.directDeliveries.push(entry);
    if (this.directDeliveries.length > MAX_TRACKED_DIRECT_DELIVERIES) this.directDeliveries.shift();
  }

  takeDirectDeliveries(): Array<{ artifactId: string; question: string }> {
    return this.directDeliveries.splice(0, this.directDeliveries.length);
  }

  private routeFor(): "direct" | "delegate" | "disabled" {
    if (config.VISION_ROUTING_MODE === "disabled") return "disabled";
    if (config.VISION_ROUTING_MODE === "always_delegate") return "delegate";
    return this.supportsImages() ? "direct" : "delegate";
  }

  async inspect(request: {
    question: string;
    image: VisionImage;
    signal?: AbortSignal;
  }): Promise<VisionOutcome> {
    const startedAt = Date.now();
    const question = boundedText(request.question, 1_000) || DEFAULT_INSPECTION_QUESTION;
    const elapsed = () => Date.now() - startedAt;

    if (request.image.bytes > config.VISION_MAX_IMAGE_BYTES) {
      throw new Error(
        `The image is ${request.image.bytes} bytes, over the ${config.VISION_MAX_IMAGE_BYTES} byte limit for visual analysis.`,
      );
    }
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(request.image.mimeType)) {
      throw new Error(`${request.image.mimeType} is not a supported image type for visual analysis.`);
    }

    const route = this.routeFor();
    if (route === "disabled") {
      return {
        decision: "disabled",
        text: "Visual analysis is turned off for this deployment, so the screenshot is available in the chat only.",
        structured: false,
        durationMs: elapsed(),
      };
    }
    if (route === "direct") {
      return {
        decision: "direct",
        text: question,
        image: request.image,
        structured: false,
        durationMs: elapsed(),
      };
    }
    return this.delegate({ question, image: request.image, signal: request.signal, startedAt });
  }

  private async delegate(input: {
    question: string;
    image: VisionImage;
    signal?: AbortSignal;
    startedAt: number;
  }): Promise<VisionOutcome> {
    const elapsed = () => Date.now() - input.startedAt;
    const visionModelId = config.VISION_MODEL;
    if (!visionModelId) {
      return {
        decision: "unavailable",
        text:
          "This model cannot read images and no vision model is configured, so the screenshot is available in the chat only. " +
          "Use browser_snapshot to reason about the page.",
        structured: false,
        durationMs: elapsed(),
      };
    }

    const model = await this.resolveVisionModel(input.signal);
    if (!model) {
      return {
        decision: "unavailable",
        text:
          `The configured vision model ${visionModelId} does not report image input support, so the screenshot was not analysed. ` +
          "Use browser_snapshot to reason about the page.",
        structured: false,
        durationMs: elapsed(),
      };
    }

    const estimate = this.estimateCostUsd(model.cost, input.question);
    if (!this.options.cost.canAfford(estimate)) {
      return {
        decision: "budget_exhausted",
        text:
          "The remaining run budget is too small to analyse this screenshot, so it is available in the chat only. " +
          "Use browser_snapshot to reason about the page.",
        structured: false,
        visionModelId: model.id,
        durationMs: elapsed(),
      };
    }

    const context: Context = {
      systemPrompt: OBSERVER_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Question: ${input.question}` },
            { type: "image", data: input.image.base64, mimeType: input.image.mimeType },
          ],
          timestamp: input.startedAt,
        },
      ],
    };

    const timeout = AbortSignal.timeout(config.VISION_REQUEST_TIMEOUT_SECONDS * 1_000);
    const message = await this.options.complete(model, context, {
      apiKey: this.options.apiKey(),
      maxTokens: VISION_MAX_TOKENS,
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      onPayload: this.options.onPayload,
    });

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || "The vision model did not return an analysis.");
    }

    const usage: VisionCharge = {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      costUsd: message.usage.cost.total,
    };
    this.options.cost.addVisionUsage(usage);

    const raw = assistantText(message);
    const analysis = parseVisionAnalysis(raw);
    if (!analysis) {
      this.log.warn({ visionModel: model.id }, "Vision model returned an unparseable analysis");
      const bounded = boundedText(raw, FALLBACK_TEXT_LIMIT);
      return {
        decision: "delegated",
        text: bounded
          ? `Visual analysis of the screenshot (inspected by ${model.id}, unstructured):\n\n${bounded}`
          : `The vision model ${model.id} returned no readable analysis of the screenshot.`,
        structured: false,
        visionModelId: model.id,
        usage,
        durationMs: elapsed(),
      };
    }

    return {
      decision: "delegated",
      text: renderAnalysis(analysis, model.id),
      analysis,
      structured: true,
      visionModelId: model.id,
      usage,
      durationMs: elapsed(),
    };
  }

  private estimateCostUsd(rates: ModelCostRates, question: string): number {
    const inputTokens = ESTIMATED_IMAGE_INPUT_TOKENS + Math.ceil(question.length / 4);
    const estimate = (inputTokens * rates.input + ESTIMATED_OUTPUT_TOKENS * rates.output) / 1_000_000;
    return Math.max(estimate, MINIMUM_BUDGET_USD);
  }

  private async resolveVisionModel(signal?: AbortSignal): Promise<Model<any> | null> {
    if (this.visionModelChecked) return this.visionModel;
    this.visionModelChecked = true;

    const modelId = config.VISION_MODEL;
    try {
      const capability = await this.capabilities.capabilityOf(modelId, signal);
      if (!capability.supportsImages) {
        this.log.warn({ visionModel: modelId, source: capability.source }, "Configured vision model cannot read images");
        return null;
      }
      const rates = await this.capabilities.costRatesFor(modelId, signal);
      this.visionModel = {
        id: capability.modelId,
        name: capability.modelId,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: rates ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: VISION_MAX_TOKENS,
      } as Model<any>;
    } catch (error) {
      this.log.warn({ error: errorForLog(error), visionModel: modelId }, "Vision model could not be resolved");
      this.visionModel = null;
    }
    return this.visionModel;
  }
}

export function createRunVisionRouter(options: RunVisionRouterOptions): RunVisionRouter {
  return new RunVisionRouter(options);
}

export const CAPABILITY_FALLBACK_NOTICE =
  "Platform notice: this model cannot read images, so the screenshot was described by a vision model instead.";

export async function recoverFromUnsupportedImage(input: {
  errorMessage: string | undefined;
  vision: RunVisionRouter;
  chatId: string;
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  steer: (text: string) => void;
  now?: () => number;
}): Promise<boolean> {
  if (!isUnsupportedImageError(input.errorMessage)) return false;
  if (!input.vision.demoteToTextOnly()) return false;

  const log = logger.child({ component: "vision-router" });
  await input.emit("vision_capability_fallback", {
    model: input.vision.primaryModelId,
    reason: "image_input_unsupported",
  });
  log.warn({ model: input.vision.primaryModelId }, "Primary model rejected image input; delegating");

  const analyses: string[] = [];
  for (const delivery of input.vision.takeDirectDeliveries()) {
    try {
      const image = await loadImageArtifact({ artifactId: delivery.artifactId, chatId: input.chatId });
      const outcome = await input.vision.inspect({ question: delivery.question, image });
      analyses.push(outcome.text);
    } catch (error) {
      log.warn(
        { error: errorForLog(error), artifactId: delivery.artifactId },
        "Screenshot could not be re-analysed after the capability fallback",
      );
    }
  }

  input.steer([CAPABILITY_FALLBACK_NOTICE, ...analyses].join("\n\n"));
  return true;
}
