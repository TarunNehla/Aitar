import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });

export const { useSession, signIn, signOut, linkSocial, listAccounts } = authClient;

export type SocialProvider = "google" | "github";

export const providerLabels: Record<SocialProvider, string> = {
  google: "Google",
  github: "GitHub",
};

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

export function describeOAuthError(code: string | null): string | null {
  if (!code) return null;
  return oauthErrorMessages[code] ?? "Sign-in did not complete. Try again";
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

export function readAuthQueryParameters(search: string) {
  const parameters = new URLSearchParams(search);
  return {
    oauthError: describeOAuthError(parameters.get("error")),
    installationError: describeInstallationError(parameters.get("github_error")),
    installationId: parameters.get("github_installation"),
  };
}

export function clearAuthQueryParameters() {
  const url = new URL(window.location.href);
  for (const key of ["error", "github_error", "github_installation"]) url.searchParams.delete(key);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
