import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import {
  config,
  emailPasswordAuthConfigured,
  githubProviderConfigured,
  googleProviderConfigured,
} from "../config.js";
import { db } from "../db/client.js";
import { authSchema } from "../db/auth-schema.js";
import { deliverInBackground, resetPasswordEmail, verificationEmail } from "../email/email.js";
import { logger } from "../logger.js";

const authLogger = logger.child({ component: "auth" });

const sessionExpirySeconds = 60 * 60 * 24 * 7;
const sessionUpdateAgeSeconds = 60 * 60 * 24;
const authTokenLifetimeSeconds = 60 * 60;

const emailAddressPattern = /[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/g;

/** Better Auth names the address in some credential messages, so nothing it writes goes out unmasked. */
const bridgedLogger: NonNullable<BetterAuthOptions["logger"]> = {
  level: config.NODE_ENV === "production" ? "warn" : "info",
  log(level, message) {
    authLogger[level]({ source: "better-auth" }, message.replace(emailAddressPattern, "[Redacted]"));
  },
};

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

export function credentialOptions(
  enabled: boolean,
): Pick<BetterAuthOptions, "emailAndPassword" | "emailVerification"> {
  if (!enabled) return { emailAndPassword: { enabled: false } };

  return {
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: authTokenLifetimeSeconds,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        deliverInBackground(
          { to: user.email, ...resetPasswordEmail({ name: user.name, url }) },
          "reset_password",
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: authTokenLifetimeSeconds,
      async sendVerificationEmail({ user, url }) {
        deliverInBackground({ to: user.email, ...verificationEmail({ name: user.name, url }) }, "verify_email");
      },
    },
  };
}

/**
 * Stricter than Better Auth's defaults on every endpoint that accepts a
 * credential or sends mail. Memory storage suits the single-backend V0.
 */
const credentialRateLimits: NonNullable<BetterAuthOptions["rateLimit"]> = {
  enabled: config.NODE_ENV === "production",
  storage: "memory",
  customRules: {
    "/sign-in/email": { window: 60, max: 5 },
    "/sign-up/email": { window: 60, max: 5 },
    "/send-verification-email": { window: 60, max: 3 },
    "/request-password-reset": { window: 60, max: 3 },
    "/reset-password": { window: 60, max: 5 },
    "/change-password": { window: 60, max: 5 },
  },
};

export const baseAuthOptions = {
  appName: "Aitar",
  baseURL: config.APP_URL,
  basePath: "/api/auth",
  secret: config.BETTER_AUTH_SECRET,
  telemetry: { enabled: false },
  trustedOrigins: config.TRUSTED_ORIGINS,
  logger: bridgedLogger,
  ...credentialOptions(emailPasswordAuthConfigured),
  socialProviders: socialProviders(),
  rateLimit: credentialRateLimits,
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
} satisfies BetterAuthOptions;

export const auth = betterAuth({
  ...baseAuthOptions,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
});

export type AuthUser = typeof auth.$Infer.Session.user;
