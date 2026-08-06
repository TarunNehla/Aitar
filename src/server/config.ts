import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

if (existsSync(".env")) loadEnvFile(".env");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().default("deepseek/deepseek-v4-flash-0731"),
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
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
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

const appUrl = new URL(parsed.data.APP_URL);
const isProduction = parsed.data.NODE_ENV === "production";

if (isProduction && appUrl.protocol !== "https:") {
  throw new Error("APP_URL must use HTTPS in production");
}

const developmentOrigins = ["http://localhost:5173", `http://localhost:${parsed.data.PORT}`];

export const config = {
  ...parsed.data,
  APP_URL: appUrl.origin,
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

export const googleProviderConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
export const githubProviderConfigured = Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
export const githubAppConfigured = Boolean(
  config.GITHUB_APP_ID && config.GITHUB_APP_SLUG && config.GITHUB_APP_PRIVATE_KEY,
);
export const githubWebhookConfigured = Boolean(config.GITHUB_WEBHOOK_SECRET);
