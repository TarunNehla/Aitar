import { randomUUID } from "node:crypto";
import pino, { type LoggerOptions } from "pino";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";

const REDACTED = "[Redacted]";

const secretKeys = [
  "apiKey",
  "authorization",
  "cookie",
  "clientSecret",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "sessionToken",
  "token",
  "privateKey",
  "webhookSecret",
  "password",
  "secret",
  "databaseUrl",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
];

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-hub-signature-256']",
  "res.headers['set-cookie']",
  "body",
  "request.body",
  "payload",
  "args.content",
  "arguments.content",
  ...secretKeys,
  ...secretKeys.map((key) => `*.${key}`),
  ...secretKeys.map((key) => `*.*.${key}`),
];

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[Redacted]"],
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[Redacted]@"],
  [/x-access-token:[^@\s/]+/gi, "x-access-token:[Redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh_[Redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[Redacted]"],
  [/(?<![\w-])(authorization|bearer|token)\s*[=:]\s*[^\s"',@]+/gi, "$1=[Redacted]"],
];

export function redactSecrets(value: string): string {
  return secretPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));
  const scrubbed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    scrubbed[key] = scrubValue(entry, depth + 1);
  }
  return scrubbed;
}

export function createLoggerOptions(input: { enabled?: boolean; pretty?: boolean } = {}): LoggerOptions {
  const options: LoggerOptions = {
    name: "cloud-agents",
    level: config.LOG_LEVEL,
    enabled: input.enabled ?? config.NODE_ENV !== "test",
    serializers: {
      err: pino.stdSerializers.err,
    },
    formatters: {
      log(object) {
        return scrubValue(object) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((argument) =>
          typeof argument === "string" ? redactSecrets(argument) : argument,
        ) as typeof args;
        return method.apply(this, scrubbed);
      },
    },
    redact: {
      paths: redactPaths,
      censor: REDACTED,
    },
  };

  const pretty = input.pretty ?? (config.LOG_PRETTY && config.NODE_ENV !== "test");
  if (pretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  }

  return options;
}

export const logger = pino(createLoggerOptions());

export function errorForLog(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name, ...(code ? { code } : {}) };
}

export const httpLogger = pinoHttp({
  logger,
  quietReqLogger: true,
  genReqId(request, response) {
    const supplied = request.headers["x-request-id"];
    const requestId = typeof supplied === "string" && supplied.length <= 128 ? supplied : randomUUID();
    response.setHeader("x-request-id", requestId);
    return requestId;
  },
  serializers: {
    req(request) {
      return {
        id: request.id,
        method: request.method,
        url: redactSecrets(String(request.url)),
        remoteAddress: request.remoteAddress,
      };
    },
    res(response) {
      return { statusCode: response.statusCode };
    },
  },
  autoLogging: {
    ignore: (request) => request.url === "/api/health",
  },
  customLogLevel(_request, response, error) {
    if (error || response.statusCode >= 500) return "error";
    if (response.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(request) {
    return `${request.method} request completed`;
  },
  customErrorMessage(request) {
    return `${request.method} request failed`;
  },
});
