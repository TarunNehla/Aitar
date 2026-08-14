import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });

export const {
  useSession,
  signIn,
  signUp,
  signOut,
  linkSocial,
  listAccounts,
  sendVerificationEmail,
  requestPasswordReset,
  resetPassword,
  changePassword,
} = authClient;

export type SocialProvider = "google" | "github";

export const providerLabels: Record<SocialProvider, string> = {
  google: "Google",
  github: "GitHub",
};

export const resetPasswordPath = "/reset-password";

export const genericSignUpResult =
  "If an account can be created with that address, we sent a verification link.";
export const genericPasswordResetResult =
  "If an account exists for that address, we sent password-reset instructions.";
export const incorrectCredentials = "The email or password is incorrect.";
export const unverifiedEmailNotice = "Verify your email before signing in. We sent a new verification link.";

const oauthErrorMessages: Record<string, string> = {
  account_not_linked:
    "That account is not connected yet. Sign in with your original provider, then connect this one from your account menu",
  email_not_verified: "That provider did not confirm your email address",
  invalid_state: "The sign-in link expired. Try again",
  please_restart_the_process: "The sign-in link expired. Try again",
  signup_disabled: "New accounts are not being accepted right now",
  unable_to_create_user: "Your account could not be created. Try again",
  state_mismatch: "The sign-in link expired. Try again",
};

/** Better Auth redirects a failed verification back to the app with an uppercase code. */
const verificationErrorMessages: Record<string, string> = {
  TOKEN_EXPIRED: "That verification link expired. Request a new one below",
  INVALID_TOKEN: "That verification link is not valid. Request a new one below",
  USER_NOT_FOUND: "That verification link is not valid. Request a new one below",
  INVALID_USER: "That verification link is not valid. Request a new one below",
};

const credentialErrorMessages: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: incorrectCredentials,
  INVALID_EMAIL: "Enter a valid email address",
  INVALID_PASSWORD: "That password is incorrect",
  PASSWORD_TOO_SHORT: "Use a password of at least 8 characters",
  PASSWORD_TOO_LONG: "Use a password of at most 128 characters",
  INVALID_TOKEN: "That reset link is not valid or has already been used. Request a new one",
  TOKEN_EXPIRED: "That reset link expired. Request a new one",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Set a password with “Forgot password” before changing it",
  EMAIL_PASSWORD_DISABLED: "Email and password sign-in is not available",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "Email and password accounts are not being accepted right now",
  RESET_PASSWORD_DISABLED: "Password reset is not available",
  VERIFICATION_EMAIL_NOT_ENABLED: "Verification email is not available",
  EMAIL_ALREADY_VERIFIED: "That email is already verified. Sign in with your password",
  SESSION_NOT_FRESH: "Sign in again before changing your password",
  UNAUTHORIZED: "Sign in again before changing your password",
};

export interface AuthErrorLike {
  code?: string;
  message?: string;
  status?: number;
}

export function describeRetryAfter(seconds: number | null): string {
  if (seconds === null) return "Too many attempts. Try again shortly.";
  return `Too many attempts. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

export function describeAuthError(
  error: AuthErrorLike | null | undefined,
  retryAfterSeconds: number | null = null,
): string {
  if (!error) return "Something went wrong. Try again";
  if (error.status === 429) return describeRetryAfter(retryAfterSeconds);
  const mapped = error.code ? credentialErrorMessages[error.code] : undefined;
  return mapped ?? "Something went wrong. Try again";
}

export function describeOAuthError(code: string | null): string | null {
  if (!code) return null;
  return oauthErrorMessages[code] ?? verificationErrorMessages[code] ?? "Sign-in did not complete. Try again";
}

export function describeInstallationError(code: string | null): string | null {
  if (!code) return null;
  if (code === "invalid_state") return "The GitHub installation link expired. Start the connection again";
  if (code === "missing_installation") return "GitHub did not return an installation. Start the connection again";
  if (code === "approval_required") {
    return "An organisation owner has to approve this installation. Retry once GitHub confirms it";
  }
  return "The GitHub App installation could not be read. Check the installation on GitHub and retry";
}

/**
 * Rate limit responses carry the wait in a header, which the client only exposes
 * through the per-request error hook.
 */
export function retryAfterCollector() {
  const state: { seconds: number | null } = { seconds: null };
  return {
    state,
    fetchOptions: {
      onError(context: { response: Response }) {
        const seconds = Number(context.response.headers.get("X-Retry-After"));
        state.seconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
      },
    },
  };
}

export interface AuthMethods {
  emailPassword: boolean;
}

let authMethodsRequest: Promise<AuthMethods> | null = null;

export function loadAuthMethods(): Promise<AuthMethods> {
  authMethodsRequest ??= fetch("/api/auth-methods")
    .then((response) => (response.ok ? (response.json() as Promise<AuthMethods>) : { emailPassword: false }))
    .catch(() => ({ emailPassword: false }));
  return authMethodsRequest;
}

export function useAuthMethods(): AuthMethods | null {
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let active = true;
    void loadAuthMethods().then((result) => {
      if (active) setMethods(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return methods;
}

export function readAuthQueryParameters(search: string) {
  const parameters = new URLSearchParams(search);
  return {
    oauthError: describeOAuthError(parameters.get("error")),
    installationError: describeInstallationError(parameters.get("github_error")),
    installationId: parameters.get("github_installation"),
  };
}

export function readResetPasswordToken(location: { pathname: string; search: string }): string | null {
  if (location.pathname !== resetPasswordPath) return null;
  return new URLSearchParams(location.search).get("token");
}

export function clearAuthQueryParameters() {
  const url = new URL(window.location.href);
  for (const key of ["error", "github_error", "github_installation", "token"]) url.searchParams.delete(key);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

export function returnToSignIn() {
  window.history.replaceState({}, "", "/");
}
