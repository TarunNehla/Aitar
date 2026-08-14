import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import {
  config,
  githubProviderConfigured,
  googleProviderConfigured,
} from "../config.js";
import { db } from "../db/client.js";
import { authSchema } from "../db/auth-schema.js";
import { logger } from "../logger.js";

const authLogger = logger.child({ component: "auth" });

const sessionExpirySeconds = 60 * 60 * 24 * 7;
const sessionUpdateAgeSeconds = 60 * 60 * 24;

function socialProviders(): NonNullable<BetterAuthOptions["socialProviders"]> {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (googleProviderConfigured) {
    providers.google = {
      clientId: config.GOOGLE_CLIENT_ID as string,
      clientSecret: config.GOOGLE_CLIENT_SECRET as string,
      prompt: "select_account",
    };
  } else {
    authLogger.warn("Google sign-in is disabled because GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing");
  }

  if (githubProviderConfigured) {
    providers.github = {
      clientId: config.GITHUB_CLIENT_ID as string,
      clientSecret: config.GITHUB_CLIENT_SECRET as string,
    };
  } else {
    authLogger.warn("GitHub sign-in is disabled because GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing");
  }

  return providers;
}

export const auth = betterAuth({
  appName: "Aitar",
  baseURL: config.APP_URL,
  basePath: "/api/auth",
  secret: config.BETTER_AUTH_SECRET,
  telemetry: { enabled: false },
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  trustedOrigins: config.TRUSTED_ORIGINS,
  emailAndPassword: { enabled: false },
  socialProviders: socialProviders(),
  user: { modelName: "users" },
  verification: { modelName: "verifications" },
  session: {
    modelName: "auth_sessions",
    expiresIn: sessionExpirySeconds,
    updateAge: sessionUpdateAgeSeconds,
    cookieCache: { enabled: false },
  },
  account: {
    modelName: "accounts",
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
      trustedProviders: [],
      updateUserInfoOnLink: false,
    },
  },
  advanced: {
    useSecureCookies: config.NODE_ENV === "production",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },
});

export type AuthUser = typeof auth.$Infer.Session.user;
