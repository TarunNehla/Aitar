import type { AuthMode } from "./auth-flow";

export const brandName = "Aitar";

export interface AuthViewCopy {
  heading: string;
  helper?: string;
  action?: string;
}

export const authViewCopy: Record<AuthMode, AuthViewCopy> = {
  "sign-in": { heading: "Welcome back", helper: "Sign in to continue", action: "Sign in" },
  "sign-up": { heading: "Create your account", action: "Create account" },
  "forgot-password": { heading: "Forgot password", action: "Send reset link" },
  "reset-password": { heading: "Choose a new password", action: "Reset password" },
  "verify-email": { heading: "Check your email" },
  "link-expired": { heading: "That link expired" },
};

export const authLabels = {
  name: "Name",
  email: "Email",
  password: "Password",
  newPassword: "New password",
  confirmPassword: "Confirm password",
  rememberMe: "Remember me",
  forgotPassword: "Forgot password?",
  backToSignIn: "Back to sign in",
  createAccount: "Create one",
  noAccount: "No account?",
  haveAccount: "Already have an account?",
  signIn: "Sign in",
  resend: "Resend verification email",
  requestNewLink: "Request a new link",
  dividerOr: "or",
  passwordRequirement: "At least 8 characters",
} as const;

export const authFieldErrors = {
  name: "Enter your name",
  email: "Enter a valid email address",
  password: "Enter your password",
  passwordTooShort: "Use at least 8 characters",
  passwordTooLong: "Use at most 128 characters",
  confirmation: "Both passwords must match",
} as const;

export const socialAccountHint =
  "If you signed up with Google or GitHub, use Forgot password to set one.";

export const resendResult = "If that address needs verifying, a new link is on its way.";

export const linkExpiredHelper: Record<"reset" | "verification", string> = {
  reset: "Reset links can only be used once.",
  verification: "Verification links can only be used once.",
};

export const resetPasswordSuccess = "Password updated. Other sessions were signed out.";
