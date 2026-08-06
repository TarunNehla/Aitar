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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.message}`);
}

export const config = {
  ...parsed.data,
  WORKSPACE_ROOT: resolve(parsed.data.WORKSPACE_ROOT),
  LOG_LEVEL: parsed.data.LOG_LEVEL ?? (parsed.data.NODE_ENV === "production" ? "info" : "debug"),
  LOG_PRETTY: parsed.data.LOG_PRETTY
    ? parsed.data.LOG_PRETTY === "true"
    : parsed.data.NODE_ENV === "development",
};
