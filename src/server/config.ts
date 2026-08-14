import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

if (existsSync(".env")) loadEnvFile(".env");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().default("deepseek/deepseek-v4-flash-0731"),
  OPENROUTER_PROVIDERS: z.string().default(""),
  OPENROUTER_ALLOW_FALLBACKS: z.enum(["true", "false"]).default("true"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  WORKSPACE_ROOT: z.string().default(".cloud-agent"),
  MAX_ACTIVE_RUNS: z.coerce.number().int().positive().default(1),
  CHAT_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  EVICTION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  RUN_MAX_TURNS: z.coerce.number().int().positive().default(30),
  RUN_MAX_COST_USD: z.coerce.number().positive().default(2),
  SANDBOX_IMAGE: z.string().default("node:22-bookworm"),
  SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  SANDBOX_CPUS: z.coerce.number().positive().default(1),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  SANDBOX_DISK_GB: z.coerce.number().int().positive().default(10),
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  SANDBOX_MAX_PROCESSES: z.coerce.number().int().positive().default(8),
  BROWSER_ENABLED: z.enum(["true", "false"]).default("true"),
  BROWSER_IMAGE: z.string().default("aitar-browser:chromium"),
  BROWSER_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  BROWSER_CPUS: z.coerce.number().positive().default(0.5),
  BROWSER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  BROWSER_IDLE_MINUTES: z.coerce.number().int().positive().default(10),
  BROWSER_MAX_TABS: z.coerce.number().int().positive().default(2),
  BROWSER_ACTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  BROWSER_NAVIGATION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  BROWSER_SCREENSHOT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
  VISION_ROUTING_MODE: z.enum(["auto", "always_delegate", "disabled"]).default("auto"),
  VISION_MODEL: z.string().default(""),
  VISION_CAPABILITY_OVERRIDES: z.string().default(""),
  VISION_CAPABILITY_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(21_600),
  VISION_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  VISION_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10_485_760),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  LOG_PRETTY: z.enum(["true", "false"]).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_INSTALLATION_STATE_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(600),
});

function withoutBlankValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

const parsed = envSchema.safeParse(withoutBlankValues(process.env));

if (!parsed.success) {
  const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(`Invalid environment. Check these variables: ${fields}`);
}

function normalisePrivateKey(value: string | undefined): string | undefined {
  return value?.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function providerSlugs(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function capabilityOverrides(value: string): Record<string, "image" | "text"> {
  const entries: Array<[string, "image" | "text"]> = [];
  for (const entry of value.split(",")) {
    const [rawId, rawMode] = entry.split("=");
    const id = rawId?.trim().toLowerCase();
    const mode = rawMode?.trim().toLowerCase();
    if (!id) continue;
    if (mode !== "image" && mode !== "text") continue;
    entries.push([id, mode]);
  }
  return Object.fromEntries(entries);
}

const appUrl = new URL(parsed.data.APP_URL);
const isProduction = parsed.data.NODE_ENV === "production";

if (isProduction && appUrl.protocol !== "https:") {
  throw new Error("APP_URL must use HTTPS in production");
}

const developmentOrigins = ["http://localhost:5173", `http://localhost:${parsed.data.PORT}`];

export const config = {
  ...parsed.data,
  APP_URL: appUrl.origin,
  OPENROUTER_PROVIDERS: providerSlugs(parsed.data.OPENROUTER_PROVIDERS),
  OPENROUTER_ALLOW_FALLBACKS: parsed.data.OPENROUTER_ALLOW_FALLBACKS === "true",
  BROWSER_ENABLED: parsed.data.BROWSER_ENABLED === "true",
  VISION_MODEL: parsed.data.VISION_MODEL.trim(),
  VISION_CAPABILITY_OVERRIDES: capabilityOverrides(parsed.data.VISION_CAPABILITY_OVERRIDES),
  GITHUB_APP_PRIVATE_KEY: normalisePrivateKey(parsed.data.GITHUB_APP_PRIVATE_KEY),
  WORKSPACE_ROOT: resolve(parsed.data.WORKSPACE_ROOT),
  LOG_LEVEL: parsed.data.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  LOG_PRETTY: parsed.data.LOG_PRETTY
    ? parsed.data.LOG_PRETTY === "true"
    : parsed.data.NODE_ENV === "development",
  TRUSTED_ORIGINS: isProduction
    ? [appUrl.origin]
    : [...new Set([appUrl.origin, ...developmentOrigins])],
};

export const visionDelegationConfigured = Boolean(config.VISION_MODEL);

export const googleProviderConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
export const githubProviderConfigured = Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
export const githubAppConfigured = Boolean(
  config.GITHUB_APP_ID && config.GITHUB_APP_SLUG && config.GITHUB_APP_PRIVATE_KEY,
);
export const githubWebhookConfigured = Boolean(config.GITHUB_WEBHOOK_SECRET);
