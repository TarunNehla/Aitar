import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLoggerOptions, errorForLog } from "./logger.js";

describe("logger", () => {
  it("redacts secrets and request content", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const testLogger = pino(createLoggerOptions({ enabled: true, pretty: false }), destination);

    testLogger.info(
      {
        apiKey: "secret-key",
        databaseUrl: "postgresql://secret",
        body: { text: "private prompt" },
        req: { headers: { authorization: "Bearer secret", cookie: "session=secret" } },
      },
      "Redaction test",
    );

    const entry = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(entry.apiKey).toBe("[Redacted]");
    expect(entry.databaseUrl).toBe("[Redacted]");
    expect(entry.body).toBe("[Redacted]");
    expect(entry.req).toEqual({
      headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
    });
  });

  it("does not expose error messages", () => {
    const error = Object.assign(new Error("private command output"), { code: "EFAIL" });
    expect(errorForLog(error)).toEqual({ name: "Error", code: "EFAIL" });
  });
});
