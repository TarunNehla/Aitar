import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailDeliveryError,
  deliverInBackground,
  escapeHtml,
  resetPasswordEmail,
  sendEmail,
  verificationEmail,
} from "../email.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

const verifyUrl = "http://localhost:5173/api/auth/verify-email?token=secret-token-value&callbackURL=%2F";
const resetUrl = "http://localhost:5173/api/auth/reset-password/secret-token-value?callbackURL=%2F";

function transport(status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ id: "message-1" }), { status }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Resend transport", () => {
  it("posts one message with the configured sender and a bearer key", async () => {
    const fetchMock = transport();
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({ to: "ada@example.com", subject: "Subject", text: "Body", html: "<p>Body</p>" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${config.RESEND_API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      from: config.AUTH_EMAIL_FROM,
      to: ["ada@example.com"],
      subject: "Subject",
      text: "Body",
      html: "<p>Body</p>",
    });
  });

  it("reports a rejected delivery without repeating the message", async () => {
    vi.stubGlobal("fetch", transport(422));

    const failure = await sendEmail({
      to: "ada@example.com",
      subject: "Subject",
      text: verifyUrl,
      html: `<p>${verifyUrl}</p>`,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmailDeliveryError);
    expect((failure as EmailDeliveryError).status).toBe(422);
    expect((failure as Error).message).not.toContain("ada@example.com");
    expect((failure as Error).message).not.toContain("secret-token-value");
  });

  it("keeps a failed delivery from breaking the authentication response", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network is down");
    });
    vi.stubGlobal("fetch", failing);
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    expect(() =>
      deliverInBackground(
        { to: "ada@example.com", subject: "Reset your Aitar password", text: resetUrl, html: resetUrl },
        "reset_password",
      ),
    ).not.toThrow();

    await vi.waitFor(() => expect(failing).toHaveBeenCalled());
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());

    const [payload, message] = errorLog.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(payload).toEqual({ template: "reset_password", error: { name: "Error" } });
    expect(JSON.stringify([payload, message])).not.toContain("ada@example.com");
    expect(JSON.stringify([payload, message])).not.toContain("secret-token-value");
  });
});

describe("templates", () => {
  it("names Aitar and the current app URL in both bodies", () => {
    const verify = verificationEmail({ name: "Ada", url: verifyUrl });

    expect(verify.subject).toBe("Verify your Aitar email");
    expect(verify.text).toContain("Aitar");
    expect(verify.text).toContain(config.APP_URL);
    expect(verify.html).toContain("Aitar");
    expect(verify.html).toContain(config.APP_URL);
    expect(verify.text).toContain(verifyUrl);
    expect(verify.html).toContain(`href="${verifyUrl.replaceAll("&", "&amp;")}"`);
  });

  it("keeps the reset template separate from the verification template", () => {
    const reset = resetPasswordEmail({ name: "Ada", url: resetUrl });

    expect(reset.subject).toBe("Reset your Aitar password");
    expect(reset.text).not.toContain("Verify your Aitar email");
    expect(reset.html).toContain(resetUrl);
  });

  it("escapes a name that carries markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const verify = verificationEmail({ name: hostile, url: verifyUrl });

    expect(verify.html).not.toContain("<img");
    expect(verify.html).not.toContain('onerror="');
    expect(verify.html).toContain("&lt;img");
    expect(escapeHtml(hostile)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("greets a user with no name without leaving a gap", () => {
    expect(verificationEmail({ name: "  ", url: verifyUrl }).text.startsWith("Hi,")).toBe(true);
  });
});

describe("configuration", () => {
  it("refuses to start when email authentication has no way to send mail", async () => {
    vi.resetModules();
    vi.stubEnv("EMAIL_PASSWORD_AUTH_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("AUTH_EMAIL_FROM", "");

    await expect(import("../../config.js")).rejects.toThrow(/requires working email configuration/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses a sender address that cannot deliver", async () => {
    vi.resetModules();
    vi.stubEnv("EMAIL_PASSWORD_AUTH_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("AUTH_EMAIL_FROM", "Aitar <not-an-address>");

    await expect(import("../../config.js")).rejects.toThrow(/AUTH_EMAIL_FROM/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
