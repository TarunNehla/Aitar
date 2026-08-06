import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { config } from "../config.js";

/**
 * The provider table on an OpenRouter model page is informational only. Upstream
 * inference providers are chosen with the `provider` field on the request body.
 * https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface ProviderPreferences {
  /** Restrict routing to these providers. The request fails when none can serve the model. */
  only?: string[];
  /** Try these providers first, in order. */
  order?: string[];
  allow_fallbacks: boolean;
}

export function providerPreferences(
  providers: readonly string[],
  allowFallbacks: boolean,
): ProviderPreferences | null {
  if (providers.length === 0) return null;
  return allowFallbacks
    ? { order: [...providers], allow_fallbacks: true }
    : { only: [...providers], allow_fallbacks: false };
}

const preferences = providerPreferences(config.OPENROUTER_PROVIDERS, config.OPENROUTER_ALLOW_FALLBACKS);

export function configuredProviderPreferences(): ProviderPreferences | null {
  return preferences;
}

/**
 * Adds the configured provider preferences to every OpenRouter request body.
 * Returning undefined leaves the payload untouched.
 */
export const applyProviderRouting: NonNullable<SimpleStreamOptions["onPayload"]> = (payload, model) => {
  if (!preferences) return undefined;
  if (model.provider !== "openrouter") return undefined;
  if (typeof payload !== "object" || payload === null) return undefined;
  return { ...payload, provider: { ...preferences } };
};
