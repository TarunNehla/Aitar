import { config } from "../config.js";
import { errorForLog, logger } from "../logger.js";

const METADATA_URL = "https://openrouter.ai/api/v1/models";

const DYNAMIC_ROUTE_MODELS = new Set(["openrouter/auto"]);

export type InputModality = "text" | "image";

export type CapabilitySource = "override" | "metadata" | "unknown";

export interface ModelCapability {
  modelId: string;
  modalities: InputModality[] | null;
  supportsImages: boolean;
  source: CapabilitySource;
}

export interface ModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CachedMetadata {
  modalities: InputModality[] | null;
  contextLength: number | null;
  expiresAt: number;
}

interface MetadataEntry {
  modalities: InputModality[] | null;
  contextLength: number | null;
  cost: ModelCostRates | null;
}

function perMillion(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000_000 : 0;
}

export function exactModelId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normaliseModelId(value: unknown): string {
  const [id] = exactModelId(value).split(":");
  return (id ?? "").trim();
}

function readModalities(value: unknown): InputModality[] | null {
  if (!Array.isArray(value)) return null;
  const modalities = value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry): entry is InputModality => entry === "text" || entry === "image");
  return modalities.length > 0 ? [...new Set(modalities)] : null;
}

function readContextLength(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export class ModelCapabilityService {
  private readonly cache = new Map<string, CachedMetadata>();
  private inFlight: Promise<Map<string, MetadataEntry>> | null = null;
  private readonly log = logger.child({ component: "model-capability" });

  constructor(
    private readonly fetchImplementation: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Date.now(),
  ) {}

  clear(): void {
    this.cache.clear();
    this.inFlight = null;
  }

  private cached(modelId: string): CachedMetadata | null {
    const key = exactModelId(modelId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  private remember(modelId: string, patch: Partial<Omit<CachedMetadata, "expiresAt">>): void {
    const key = exactModelId(modelId);
    const entry = this.cached(key);
    this.cache.set(key, {
      modalities: entry?.modalities ?? null,
      contextLength: entry?.contextLength ?? null,
      ...patch,
      expiresAt: this.now() + config.VISION_CAPABILITY_CACHE_TTL_SECONDS * 1_000,
    });
  }

  cachedModalities(modelId: string): InputModality[] | null {
    return this.cached(modelId)?.modalities ?? null;
  }

  cachedContextWindow(modelId: string): number | null {
    return this.cached(modelId)?.contextLength ?? null;
  }

  private override(modelId: string): InputModality[] | null {
    const overrides = config.VISION_CAPABILITY_OVERRIDES;
    const configured = overrides[exactModelId(modelId)] ?? overrides[normaliseModelId(modelId)];
    if (configured === "image") return ["text", "image"];
    if (configured === "text") return ["text"];
    return null;
  }

  private lookup(entries: Map<string, MetadataEntry>, modelId: string): MetadataEntry | undefined {
    return entries.get(exactModelId(modelId)) ?? entries.get(normaliseModelId(modelId));
  }

  async capabilityOf(modelId: string, signal?: AbortSignal): Promise<ModelCapability> {
    const id = exactModelId(modelId);
    const overridden = this.override(id);
    if (overridden) {
      return { modelId: id, modalities: overridden, supportsImages: overridden.includes("image"), source: "override" };
    }

    const unknown: ModelCapability = { modelId: id, modalities: null, supportsImages: false, source: "unknown" };
    if (!id || DYNAMIC_ROUTE_MODELS.has(normaliseModelId(id))) return unknown;

    const cached = this.cachedModalities(id);
    if (cached) {
      return { modelId: id, modalities: cached, supportsImages: cached.includes("image"), source: "metadata" };
    }

    const entry = this.lookup(await this.metadata(signal), id);
    if (!entry?.modalities) return unknown;

    this.remember(id, { modalities: entry.modalities, contextLength: entry.contextLength });
    return {
      modelId: id,
      modalities: entry.modalities,
      supportsImages: entry.modalities.includes("image"),
      source: "metadata",
    };
  }

  /** The model's own advertised context length. Null keeps callers from borrowing another model's window. */
  async contextWindowOf(modelId: string, signal?: AbortSignal): Promise<number | null> {
    const id = exactModelId(modelId);
    if (!id) return null;

    const cached = this.cachedContextWindow(id);
    if (cached) return cached;

    const contextLength = this.lookup(await this.metadata(signal), id)?.contextLength ?? null;
    if (contextLength) this.remember(id, { contextLength });
    return contextLength;
  }

  async costRatesFor(modelId: string, signal?: AbortSignal): Promise<ModelCostRates | null> {
    return this.lookup(await this.metadata(signal), modelId)?.cost ?? null;
  }

  private async metadata(signal?: AbortSignal): Promise<Map<string, MetadataEntry>> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.loadMetadata(signal).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async loadMetadata(signal?: AbortSignal): Promise<Map<string, MetadataEntry>> {
    const entries = new Map<string, MetadataEntry>();
    const timeout = AbortSignal.timeout(config.VISION_REQUEST_TIMEOUT_SECONDS * 1_000);
    try {
      const response = await this.fetchImplementation(METADATA_URL, {
        headers: { accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        this.log.warn({ status: response.status }, "OpenRouter model metadata request failed");
        return entries;
      }
      const payload = (await response.json()) as { data?: unknown };
      if (!Array.isArray(payload.data)) return entries;

      for (const model of payload.data) {
        if (!model || typeof model !== "object") continue;
        const record = model as { id?: unknown; architecture?: unknown; pricing?: unknown; context_length?: unknown };
        const id = exactModelId(record.id);
        if (!id) continue;
        const architecture = record.architecture as { input_modalities?: unknown } | undefined;
        const modalities = readModalities(architecture?.input_modalities);
        const contextLength = readContextLength(record.context_length);
        if (!modalities && !contextLength) continue;
        const pricing = record.pricing as Record<string, unknown> | undefined;
        entries.set(id, {
          modalities,
          contextLength,
          cost: pricing
            ? {
                input: perMillion(pricing.prompt),
                output: perMillion(pricing.completion),
                cacheRead: perMillion(pricing.input_cache_read),
                cacheWrite: perMillion(pricing.input_cache_write),
              }
            : null,
        });
      }
    } catch (error) {
      this.log.warn({ error: errorForLog(error) }, "OpenRouter model metadata is unavailable");
    }
    return entries;
  }
}

export const modelCapabilities = new ModelCapabilityService();

export interface ResolvedContextWindow {
  tokens: number;
  source: "metadata" | "fallback";
}

/**
 * Context window for one model, or a clear failure. Guessing here would size compaction
 * against a window the model does not have, so an unresolved model needs explicit configuration.
 */
export async function resolveContextWindow(
  modelId: string,
  capabilities: Pick<ModelCapabilityService, "contextWindowOf"> = modelCapabilities,
  signal?: AbortSignal,
): Promise<ResolvedContextWindow> {
  const advertised = await capabilities.contextWindowOf(modelId, signal);
  if (advertised) return { tokens: advertised, source: "metadata" };

  const fallback = config.CONTEXT_WINDOW_FALLBACK_TOKENS;
  if (fallback) return { tokens: fallback, source: "fallback" };

  throw new Error(
    `OpenRouter reports no context length for "${modelId}", so the compaction limit cannot be calculated. ` +
      "Set CONTEXT_WINDOW_FALLBACK_TOKENS to run this model anyway.",
  );
}
