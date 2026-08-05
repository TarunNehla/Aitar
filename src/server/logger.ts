import { randomUUID } from "node:crypto";
import pino, { type LoggerOptions } from "pino";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";

export function createLoggerOptions(input: { enabled?: boolean; pretty?: boolean } = {}): LoggerOptions {
  const options: LoggerOptions = {
    name: "cloud-agents",
    level: config.LOG_LEVEL,
    enabled: input.enabled ?? config.NODE_ENV !== "test",
    serializers: {
      err: pino.stdSerializers.err,
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "authorization",
        "cookie",
        "apiKey",
        "databaseUrl",
        "DATABASE_URL",
        "OPENROUTER_API_KEY",
        "body",
        "request.body",
        "args.content",
        "arguments.content",
      ],
      censor: "[Redacted]",
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
        url: request.url,
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
