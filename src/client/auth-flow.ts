import { useCallback, useState } from "react";
import { describeOAuthError, resetPasswordPath } from "./auth-client";
import { authFieldErrors } from "./auth-copy";

export type AuthMode =
  | "sign-in"
  | "sign-up"
  | "forgot-password"
  | "reset-password"
  | "verify-email"
  | "link-expired";

export type AuthOperation =
  | "sign-in"
  | "sign-up"
  | "forgot-password"
  | "reset-password"
  | "resend"
  | "google"
  | "github";

export type AuthFieldName = "name" | "email" | "password" | "confirmation";
export type AuthFieldErrors = Partial<Record<AuthFieldName, string>>;

export interface AuthEntry {
  mode: AuthMode;
  resetToken: string | null;
  linkKind: "reset" | "verification" | null;
  error: string | null;
  ownsPage: boolean;
}

const minPasswordLength = 8;
const maxPasswordLength = 128;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const linkFailureCodes = new Set(["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER"]);

export function looksLikeEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

export function describePasswordProblem(password: string, confirmation: string): AuthFieldErrors {
  const problems: AuthFieldErrors = {};
  if (password.length < minPasswordLength) problems.password = authFieldErrors.passwordTooShort;
  else if (password.length > maxPasswordLength) problems.password = authFieldErrors.passwordTooLong;
  if (confirmation !== password) problems.confirmation = authFieldErrors.confirmation;
  return problems;
}

export function readAuthEntry(location: { pathname: string; search: string }): AuthEntry {
  const parameters = new URLSearchParams(location.search);

  if (location.pathname === resetPasswordPath) {
    const resetToken = parameters.get("token");
    return resetToken
      ? { mode: "reset-password", resetToken, linkKind: "reset", error: null, ownsPage: true }
      : { mode: "link-expired", resetToken: null, linkKind: "reset", error: null, ownsPage: true };
  }

  const code = parameters.get("error");
  if (code && linkFailureCodes.has(code)) {
    return { mode: "link-expired", resetToken: null, linkKind: "verification", error: null, ownsPage: false };
  }

  return {
    mode: "sign-in",
    resetToken: null,
    linkKind: null,
    error: describeOAuthError(code),
    ownsPage: false,
  };
}

export const signInEntry: AuthEntry = {
  mode: "sign-in",
  resetToken: null,
  linkKind: null,
  error: null,
  ownsPage: false,
};

export interface AuthFlow {
  mode: AuthMode;
  pending: AuthOperation | null;
  busy: boolean;
  fieldErrors: AuthFieldErrors;
  error: string | null;
  success: string | null;
  email: string;
  go: (mode: AuthMode) => void;
  advance: (mode: AuthMode, message: string) => void;
  begin: (operation: AuthOperation) => void;
  settle: () => void;
  fail: (message: string) => void;
  reject: (problems: AuthFieldErrors) => void;
  succeed: (message: string) => void;
  rememberEmail: (email: string) => void;
}

export function useAuthFlow(entry: AuthEntry): AuthFlow {
  const [mode, setMode] = useState<AuthMode>(entry.mode);
  const [pending, setPending] = useState<AuthOperation | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [error, setError] = useState<string | null>(entry.error);
  const [success, setSuccess] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  const go = useCallback((next: AuthMode) => {
    setMode(next);
    setPending(null);
    setFieldErrors({});
    setError(null);
    setSuccess(null);
  }, []);

  const advance = useCallback((next: AuthMode, message: string) => {
    setMode(next);
    setPending(null);
    setFieldErrors({});
    setError(null);
    setSuccess(message);
  }, []);

  const begin = useCallback((operation: AuthOperation) => {
    setPending(operation);
    setFieldErrors({});
    setError(null);
  }, []);

  const settle = useCallback(() => setPending(null), []);

  const fail = useCallback((message: string) => {
    setPending(null);
    setError(message);
  }, []);

  const reject = useCallback((problems: AuthFieldErrors) => {
    setPending(null);
    setFieldErrors(problems);
  }, []);

  const succeed = useCallback((message: string) => {
    setPending(null);
    setError(null);
    setSuccess(message);
  }, []);

  return {
    mode,
    pending,
    busy: pending !== null,
    fieldErrors,
    error,
    success,
    email,
    go,
    advance,
    begin,
    settle,
    fail,
    reject,
    succeed,
    rememberEmail: setEmail,
  };
}
