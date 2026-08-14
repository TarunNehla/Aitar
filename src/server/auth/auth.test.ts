import { describe, expect, it } from "vitest";
import { auth, credentialOptions } from "./auth.js";
import { config, senderAddress } from "../config.js";

function providerOptions(provider: "google" | "github"): Record<string, unknown> {
  const configured = auth.options.socialProviders?.[provider];
  if (!configured || typeof configured === "function") throw new Error(`${provider} is not configured`);
  return configured as unknown as Record<string, unknown>;
}

const advancedOptions = auth.options.advanced as Record<string, unknown> | undefined;

describe("Better Auth configuration", () => {
  it("configures Google and GitHub with identity scopes only", () => {
    const google = providerOptions("google");
    expect(google.clientId).toBe(config.GOOGLE_CLIENT_ID);
    expect(google.clientSecret).toBe(config.GOOGLE_CLIENT_SECRET);
    expect(google.scope).toBeUndefined();
    expect(google.accessType).toBeUndefined();
    expect(google.disableDefaultScope).toBeUndefined();

    const github = providerOptions("github");
    expect(github.clientId).toBe(config.GITHUB_CLIENT_ID);
    expect(github.clientSecret).toBe(config.GITHUB_CLIENT_SECRET);
    expect(github.scope).toBeUndefined();
    expect(github.disableDefaultScope).toBeUndefined();
  });

  it("requires explicit account linking between providers", () => {
    const accountLinking = auth.options.account?.accountLinking;

    expect(accountLinking?.enabled).toBe(true);
    expect(accountLinking?.disableImplicitLinking).toBe(true);
    expect(accountLinking?.allowDifferentEmails).toBe(false);
    expect(accountLinking?.allowUnlinkingAll).toBe(false);
    expect(accountLinking?.trustedProviders).toEqual([]);
    expect(accountLinking?.updateUserInfoOnLink).toBe(false);
  });

  it("encrypts stored OAuth tokens", () => {
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
  });

  it("uses database-backed sessions without cookie caching", () => {
    expect(auth.options.session?.modelName).toBe("auth_sessions");
    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
  });

  it("mounts under the same-origin API path with exact trusted origins", () => {
    expect(auth.options.basePath).toBe("/api/auth");
    expect(auth.options.baseURL).toBe(config.APP_URL);
    expect(auth.options.trustedOrigins).toContain(config.APP_URL);
    expect(auth.options.trustedOrigins).not.toContain("*");
  });

  it("keeps cookies HttpOnly and SameSite protected", () => {
    const cookieAttributes = advancedOptions?.defaultCookieAttributes as Record<string, unknown>;

    expect(cookieAttributes.httpOnly).toBe(true);
    expect(cookieAttributes.sameSite).toBe("lax");
    expect(advancedOptions?.useSecureCookies).toBe(config.NODE_ENV === "production");
    expect(advancedOptions?.disableCSRFCheck).toBeUndefined();
    expect(advancedOptions?.disableOriginCheck).toBeUndefined();
  });

  it("trusts no forwarded IP header beyond the framework default", () => {
    const ipAddress = advancedOptions?.ipAddress as Record<string, unknown> | undefined;

    expect(ipAddress?.ipAddressHeaders).toBeUndefined();
    expect(ipAddress?.trustedProxies).toBeUndefined();
    expect(ipAddress?.disableIpTracking).toBeUndefined();
  });
});

describe("email and password configuration", () => {
  it("stays disabled until the deployment enables it", () => {
    const disabled = credentialOptions(false);

    expect(disabled.emailAndPassword).toEqual({ enabled: false });
    expect(disabled.emailVerification).toBeUndefined();
  });

  it("requires verification and never signs a new account in automatically", () => {
    const { emailAndPassword } = credentialOptions(true);

    expect(emailAndPassword?.enabled).toBe(true);
    expect(emailAndPassword?.requireEmailVerification).toBe(true);
    expect(emailAndPassword?.autoSignIn).toBe(false);
    expect(emailAndPassword?.minPasswordLength).toBe(8);
    expect(emailAndPassword?.maxPasswordLength).toBe(128);
    expect(emailAndPassword?.resetPasswordTokenExpiresIn).toBe(3600);
    expect(emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(emailAndPassword?.sendResetPassword).toBeTypeOf("function");
  });

  it("keeps Better Auth's own scrypt hashing", () => {
    expect(credentialOptions(true).emailAndPassword?.password).toBeUndefined();
  });

  it("sends verification on sign up and on an unverified sign in", () => {
    const { emailVerification } = credentialOptions(true);

    expect(emailVerification?.sendOnSignUp).toBe(true);
    expect(emailVerification?.sendOnSignIn).toBe(true);
    expect(emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(emailVerification?.expiresIn).toBe(3600);
    expect(emailVerification?.sendVerificationEmail).toBeTypeOf("function");
  });

  it("is enabled in this environment because email delivery is configured", () => {
    expect(config.EMAIL_PASSWORD_AUTH_ENABLED).toBe(true);
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(senderAddress(config.AUTH_EMAIL_FROM as string)).toBe("no-reply@aitar.test");
  });

  it("rejects a sender address that cannot deliver", () => {
    expect(senderAddress("Aitar <not-an-address>")).toBeNull();
    expect(senderAddress("")).toBeNull();
    expect(senderAddress("no-reply@aitar.test")).toBe("no-reply@aitar.test");
  });
});

describe("rate limiting", () => {
  const rules = auth.options.rateLimit?.customRules ?? {};

  it("runs in production with memory-backed storage and no rate-limit table", () => {
    expect(auth.options.rateLimit?.enabled).toBe(config.NODE_ENV === "production");
    expect(auth.options.rateLimit?.storage).toBe("memory");
    expect(auth.options.rateLimit?.modelName).toBeUndefined();
  });

  it("keeps every credential endpoint strictly limited", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/send-verification-email",
      "/request-password-reset",
      "/reset-password",
      "/change-password",
    ]) {
      const rule = rules[path];
      expect(rule, path).toBeTruthy();
      expect(typeof rule === "object" && rule !== null ? rule.max : Number.NaN, path).toBeLessThanOrEqual(5);
    }
  });
});
