import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLoggerOptions, errorForLog, redactSecrets } from "./logger.js";

function capture(log: (logger: pino.Logger) => void): { raw: string; entry: Record<string, unknown> } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  log(pino(createLoggerOptions({ enabled: true, pretty: false }), destination));
  const raw = lines.join("");
  return { raw, entry: JSON.parse(raw) as Record<string, unknown> };
}

describe("logger", () => {
  it("redacts secrets and request content", () => {
    const { entry } = capture((testLogger) =>
      testLogger.info(
        {
          apiKey: "secret-key",
          databaseUrl: "postgresql://secret",
          body: { text: "private prompt" },
          req: { headers: { authorization: "Bearer secret", cookie: "session=secret" } },
        },
        "Redaction test",
      ),
    );

    expect(entry.apiKey).toBe("[Redacted]");
    expect(entry.databaseUrl).toBe("[Redacted]");
    expect(entry.body).toBe("[Redacted]");
    expect(entry.req).toEqual({
      headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
    });
  });

  it("redacts OAuth, session, and GitHub App secrets by key", () => {
    const { raw } = capture((testLogger) =>
      testLogger.info(
        {
          accessToken: "at-value",
          refreshToken: "rt-value",
          idToken: "it-value",
          sessionToken: "st-value",
          clientSecret: "cs-value",
          privateKey: "pk-value",
          webhookSecret: "ws-value",
          BETTER_AUTH_SECRET: "bas-value",
          GITHUB_APP_PRIVATE_KEY: "gapk-value",
          account: { accessToken: "nested-at", refreshToken: "nested-rt" },
        },
        "Secret key redaction",
      ),
    );

    for (const value of [
      "at-value", "rt-value", "it-value", "st-value", "cs-value", "pk-value",
      "ws-value", "bas-value", "gapk-value", "nested-at", "nested-rt",
    ]) {
      expect(raw).not.toContain(value);
    }
  });

  it("redacts GitHub tokens and authorization headers found inside strings", () => {
    const installationToken = "ghs_abcdefghijklmnopqrstuvwxyz012345";
    const { raw } = capture((testLogger) =>
      testLogger.info(
        {
          remote: `https://x-access-token:${installationToken}@github.com/acme/service.git`,
          detail: `Authorization: Bearer ${installationToken}`,
          nested: { patToken: "github_pat_11ABCDEFG0abcdefghijklmnop" },
        },
        `Fetch failed for ${installationToken}`,
      ),
    );

    expect(raw).not.toContain(installationToken);
    expect(raw).not.toContain("github_pat_11ABCDEFG0abcdefghijklmnop");
    expect(raw).toContain("github.com/acme/service.git");
  });

  it("redacts credentials embedded in request URLs and private keys", () => {
    expect(redactSecrets("https://user:pass@github.com/acme/service.git")).toBe(
      "https://[Redacted]@github.com/acme/service.git",
    );
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[Redacted]");
    expect(redactSecrets("gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("gh_[Redacted]");
  });

  it("does not expose error messages", () => {
    const error = Object.assign(new Error("private command output"), { code: "EFAIL" });
    expect(errorForLog(error)).toEqual({ name: "Error", code: "EFAIL" });
  });
});
