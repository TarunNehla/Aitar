import { describe, expect, it } from "vitest";
import { auth } from "./auth.js";
import { config } from "../config.js";

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
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
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
});
