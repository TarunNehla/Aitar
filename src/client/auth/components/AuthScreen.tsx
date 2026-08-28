import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  describeAuthError,
  genericPasswordResetResult,
  genericSignUpResult,
  incorrectCredentials,
  providerLabels,
  requestPasswordReset,
  resetPassword,
  resetPasswordPath,
  retryAfterCollector,
  sendVerificationEmail,
  signIn,
  signUp,
  unverifiedEmailNotice,
  type SocialProvider,
} from "../auth-client";
import {
  authFieldErrors,
  authLabels,
  authViewCopy,
  linkExpiredHelper,
  resendResult,
  resetPasswordSuccess,
  socialAccountHint,
} from "../auth-copy";
import {
  describePasswordProblem,
  looksLikeEmail,
  useAuthFlow,
  type AuthEntry,
  type AuthFieldErrors,
  type AuthFlow,
} from "../auth-flow";
import { Spinner } from "../../components/Spinner";
import { AuthCard } from "./AuthCard";
import { AuthField } from "./AuthField";
import { AuthHeader } from "./AuthHeader";
import { AuthShell } from "./AuthShell";
import { AuthStatus } from "./AuthStatus";
import { PasswordField } from "./PasswordField";
import { SocialSignInButtons } from "./SocialSignInButtons";

const resendCooldownSeconds = 30;

export function AuthScreen({
  entry,
  emailPassword,
  onLeaveLink,
}: {
  entry: AuthEntry;
  emailPassword: boolean;
  onLeaveLink?: () => void;
}) {
  const flow = useAuthFlow(entry);

  function leaveFor(mode: "sign-in" | "forgot-password") {
    onLeaveLink?.();
    flow.go(mode);
  }

  async function startSocial(provider: SocialProvider) {
    if (flow.busy) return;
    flow.begin(provider);
    const result = await signIn.social({ provider, callbackURL: "/" });
    if (result?.error) {
      flow.fail(result.error.message ?? `${providerLabels[provider]} sign-in did not start`);
    }
  }

  const copy = authViewCopy[flow.mode];

  return (
    <AuthShell>
      <AuthCard>
        <AuthHeader heading={copy.heading} helper={copy.helper} icon={headerIcon(flow)} />

        {flow.mode === "sign-in" && (
          <SignInView flow={flow} emailPassword={emailPassword} onSocial={startSocial} />
        )}
        {flow.mode === "sign-up" && <SignUpView flow={flow} onSocial={startSocial} />}
        {flow.mode === "forgot-password" && <ForgotPasswordView flow={flow} />}
        {flow.mode === "reset-password" && (
          <ResetPasswordView flow={flow} token={entry.resetToken} onDone={() => leaveFor("sign-in")} />
        )}
        {flow.mode === "verify-email" && <VerifyEmailView flow={flow} />}
        {flow.mode === "link-expired" && (
          <LinkExpiredView
            flow={flow}
            linkKind={entry.linkKind ?? "verification"}
            onRequestNewLink={() => leaveFor("forgot-password")}
            onBack={() => leaveFor("sign-in")}
          />
        )}
      </AuthCard>
    </AuthShell>
  );
}

function headerIcon(flow: AuthFlow) {
  if (flow.mode === "verify-email") return "mail" as const;
  if (flow.mode === "link-expired") return "alert-triangle" as const;
  return undefined;
}

function socialPendingOf(flow: AuthFlow): SocialProvider | null {
  return flow.pending === "google" || flow.pending === "github" ? flow.pending : null;
}

function AuthSubmit({ label, loading, disabled }: { label: string; loading: boolean; disabled: boolean }) {
  return (
    <button className="primary-button auth-submit" type="submit" disabled={disabled}>
      {loading && <Spinner size={16} />}
      {label}
    </button>
  );
}

function AuthAlternatives({
  flow,
  onSocial,
}: {
  flow: AuthFlow;
  onSocial: (provider: SocialProvider) => void;
}) {
  return (
    <>
      <div className="auth-divider">
        <span>{authLabels.dividerOr}</span>
      </div>
      <SocialSignInButtons
        pending={socialPendingOf(flow)}
        disabled={flow.busy}
        onSelect={(provider) => void onSocial(provider)}
      />
    </>
  );
}

function AuthFooter({ children }: { children: ReactNode }) {
  return <p className="auth-footer">{children}</p>;
}

function SignInView({
  flow,
  emailPassword,
  onSocial,
}: {
  flow: AuthFlow;
  emailPassword: boolean;
  onSocial: (provider: SocialProvider) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const rememberId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flow.busy) return;

    const trimmedEmail = email.trim();
    const problems: AuthFieldErrors = {};
    if (!looksLikeEmail(trimmedEmail)) problems.email = authFieldErrors.email;
    if (!password) problems.password = authFieldErrors.password;
    if (Object.keys(problems).length > 0) {
      flow.reject(problems);
      return;
    }

    flow.begin("sign-in");
    const retry = retryAfterCollector();
    const result = await signIn.email({
      email: trimmedEmail,
      password,
      rememberMe,
      fetchOptions: retry.fetchOptions,
    });

    if (!result.error) return;
    if (result.error.code === "EMAIL_NOT_VERIFIED") {
      flow.rememberEmail(trimmedEmail);
      flow.advance("verify-email", unverifiedEmailNotice);
      return;
    }
    flow.fail(
      result.error.status === 401
        ? incorrectCredentials
        : describeAuthError(result.error, retry.state.seconds),
    );
  }

  return (
    <>
      {emailPassword && (
        <form className="auth-fields" onSubmit={submit} noValidate>
          <AuthField
            label={authLabels.email}
            type="email"
            autoComplete="email"
            value={email}
            disabled={flow.busy}
            error={flow.fieldErrors.email}
            onChange={setEmail}
          />
          <PasswordField
            label={authLabels.password}
            autoComplete="current-password"
            value={password}
            disabled={flow.busy}
            error={flow.fieldErrors.password}
            onChange={setPassword}
          />

          <div className="auth-row">
            <label className="auth-checkbox" htmlFor={rememberId}>
              <input
                id={rememberId}
                type="checkbox"
                checked={rememberMe}
                disabled={flow.busy}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              {authLabels.rememberMe}
            </label>
            <button
              className="link-button"
              type="button"
              disabled={flow.busy}
              onClick={() => flow.go("forgot-password")}
            >
              {authLabels.forgotPassword}
            </button>
          </div>

          {flow.error && <AuthStatus tone="error" message={flow.error} />}
          {flow.error === incorrectCredentials && <small className="auth-hint">{socialAccountHint}</small>}

          <AuthSubmit
            label={authViewCopy["sign-in"].action ?? authLabels.signIn}
            loading={flow.pending === "sign-in"}
            disabled={flow.busy}
          />
        </form>
      )}

      {!emailPassword && flow.error && <AuthStatus tone="error" message={flow.error} />}

      {emailPassword ? (
        <AuthAlternatives flow={flow} onSocial={onSocial} />
      ) : (
        <SocialSignInButtons
          pending={socialPendingOf(flow)}
          disabled={flow.busy}
          onSelect={(provider) => void onSocial(provider)}
        />
      )}

      {emailPassword && (
        <AuthFooter>
          {authLabels.noAccount}{" "}
          <button
            className="link-button"
            type="button"
            disabled={flow.busy}
            onClick={() => flow.go("sign-up")}
          >
            {authLabels.createAccount}
          </button>
        </AuthFooter>
      )}
    </>
  );
}

function SignUpView({ flow, onSocial }: { flow: AuthFlow; onSocial: (provider: SocialProvider) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flow.busy) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const problems: AuthFieldErrors = {
      ...(trimmedName ? {} : { name: authFieldErrors.name }),
      ...(looksLikeEmail(trimmedEmail) ? {} : { email: authFieldErrors.email }),
      ...describePasswordProblem(password, confirmation),
    };
    if (Object.keys(problems).length > 0) {
      flow.reject(problems);
      return;
    }

    flow.begin("sign-up");
    const retry = retryAfterCollector();
    const result = await signUp.email({
      name: trimmedName,
      email: trimmedEmail,
      password,
      callbackURL: "/",
      fetchOptions: retry.fetchOptions,
    });

    if (result.error) {
      flow.fail(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    flow.rememberEmail(trimmedEmail);
    flow.advance("verify-email", genericSignUpResult);
  }

  return (
    <>
      <form className="auth-fields" onSubmit={submit} noValidate>
        <AuthField
          label={authLabels.name}
          type="text"
          autoComplete="name"
          value={name}
          disabled={flow.busy}
          error={flow.fieldErrors.name}
          onChange={setName}
        />
        <AuthField
          label={authLabels.email}
          type="email"
          autoComplete="email"
          value={email}
          disabled={flow.busy}
          error={flow.fieldErrors.email}
          onChange={setEmail}
        />
        <PasswordField
          label={authLabels.password}
          autoComplete="new-password"
          value={password}
          disabled={flow.busy}
          error={flow.fieldErrors.password}
          requirement={authLabels.passwordRequirement}
          onChange={setPassword}
        />
        <PasswordField
          label={authLabels.confirmPassword}
          autoComplete="new-password"
          value={confirmation}
          disabled={flow.busy}
          error={flow.fieldErrors.confirmation}
          onChange={setConfirmation}
        />

        {flow.error && <AuthStatus tone="error" message={flow.error} />}

        <AuthSubmit
          label={authViewCopy["sign-up"].action ?? ""}
          loading={flow.pending === "sign-up"}
          disabled={flow.busy}
        />
      </form>

      <AuthAlternatives flow={flow} onSocial={onSocial} />

      <AuthFooter>
        {authLabels.haveAccount}{" "}
        <button className="link-button" type="button" disabled={flow.busy} onClick={() => flow.go("sign-in")}>
          {authLabels.signIn}
        </button>
      </AuthFooter>
    </>
  );
}

function ForgotPasswordView({ flow }: { flow: AuthFlow }) {
  const [email, setEmail] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flow.busy) return;

    const trimmedEmail = email.trim();
    if (!looksLikeEmail(trimmedEmail)) {
      flow.reject({ email: authFieldErrors.email });
      return;
    }

    flow.begin("forgot-password");
    const retry = retryAfterCollector();
    const result = await requestPasswordReset({
      email: trimmedEmail,
      redirectTo: `${window.location.origin}${resetPasswordPath}`,
      fetchOptions: retry.fetchOptions,
    });

    if (result.error?.status === 429) {
      flow.fail(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    flow.succeed(genericPasswordResetResult);
  }

  return (
    <>
      {flow.success ? (
        <AuthStatus tone="success" message={flow.success} />
      ) : (
        <form className="auth-fields" onSubmit={submit} noValidate>
          <AuthField
            label={authLabels.email}
            type="email"
            autoComplete="email"
            value={email}
            disabled={flow.busy}
            error={flow.fieldErrors.email}
            onChange={setEmail}
          />

          {flow.error && <AuthStatus tone="error" message={flow.error} />}

          <AuthSubmit
            label={authViewCopy["forgot-password"].action ?? ""}
            loading={flow.pending === "forgot-password"}
            disabled={flow.busy}
          />
        </form>
      )}

      <AuthFooter>
        <button className="link-button" type="button" disabled={flow.busy} onClick={() => flow.go("sign-in")}>
          {authLabels.backToSignIn}
        </button>
      </AuthFooter>
    </>
  );
}

function ResetPasswordView({
  flow,
  token,
  onDone,
}: {
  flow: AuthFlow;
  token: string | null;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flow.busy || !token) return;

    const problems = describePasswordProblem(password, confirmation);
    if (Object.keys(problems).length > 0) {
      flow.reject(problems);
      return;
    }

    flow.begin("reset-password");
    const retry = retryAfterCollector();
    const result = await resetPassword({ newPassword: password, token, fetchOptions: retry.fetchOptions });

    setPassword("");
    setConfirmation("");
    if (result.error) {
      flow.fail(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    flow.succeed(resetPasswordSuccess);
  }

  if (flow.success) {
    return (
      <>
        <AuthStatus tone="success" message={flow.success} />
        <button className="primary-button auth-submit" type="button" onClick={onDone}>
          {authLabels.signIn}
        </button>
      </>
    );
  }

  return (
    <>
      <form className="auth-fields" onSubmit={submit} noValidate>
        <PasswordField
          label={authLabels.newPassword}
          autoComplete="new-password"
          value={password}
          disabled={flow.busy}
          error={flow.fieldErrors.password}
          requirement={authLabels.passwordRequirement}
          onChange={setPassword}
        />
        <PasswordField
          label={authLabels.confirmPassword}
          autoComplete="new-password"
          value={confirmation}
          disabled={flow.busy}
          error={flow.fieldErrors.confirmation}
          onChange={setConfirmation}
        />

        {flow.error && <AuthStatus tone="error" message={flow.error} />}

        <AuthSubmit
          label={authViewCopy["reset-password"].action ?? ""}
          loading={flow.pending === "reset-password"}
          disabled={flow.busy}
        />
      </form>

      <AuthFooter>
        <button className="link-button" type="button" disabled={flow.busy} onClick={onDone}>
          {authLabels.backToSignIn}
        </button>
      </AuthFooter>
    </>
  );
}

function VerifyEmailView({ flow }: { flow: AuthFlow }) {
  return (
    <>
      {flow.success && <p className="auth-helper">{flow.success}</p>}
      {flow.email && <ResendVerification flow={flow} email={flow.email} />}
      <AuthFooter>
        <button className="link-button" type="button" disabled={flow.busy} onClick={() => flow.go("sign-in")}>
          {authLabels.backToSignIn}
        </button>
      </AuthFooter>
    </>
  );
}

function LinkExpiredView({
  flow,
  linkKind,
  onRequestNewLink,
  onBack,
}: {
  flow: AuthFlow;
  linkKind: "reset" | "verification";
  onRequestNewLink: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <p className="auth-helper">{linkExpiredHelper[linkKind]}</p>
      {linkKind === "reset" ? (
        <>
          <button className="primary-button auth-submit" type="button" onClick={onRequestNewLink}>
            {authLabels.requestNewLink}
          </button>
          <AuthFooter>
            <button className="link-button" type="button" disabled={flow.busy} onClick={onBack}>
              {authLabels.backToSignIn}
            </button>
          </AuthFooter>
        </>
      ) : (
        <button className="primary-button auth-submit" type="button" onClick={onBack}>
          {authLabels.backToSignIn}
        </button>
      )}
    </>
  );
}

function useCooldown() {
  const [remaining, setRemaining] = useState(0);
  const deadlineRef = useRef(0);

  useEffect(() => {
    if (remaining === 0) return;
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  return {
    remaining,
    start() {
      deadlineRef.current = Date.now() + resendCooldownSeconds * 1000;
      setRemaining(resendCooldownSeconds);
    },
  };
}

function ResendVerification({ flow, email }: { flow: AuthFlow; email: string }) {
  const cooldown = useCooldown();
  const [status, setStatus] = useState<string | null>(null);

  async function resend() {
    if (flow.busy || cooldown.remaining > 0) return;
    flow.begin("resend");
    setStatus(null);

    const retry = retryAfterCollector();
    const result = await sendVerificationEmail({ email, callbackURL: "/", fetchOptions: retry.fetchOptions });

    flow.settle();
    cooldown.start();
    setStatus(
      result.error?.status === 429 ? describeAuthError(result.error, retry.state.seconds) : resendResult,
    );
  }

  return (
    <div className="auth-resend">
      <button
        className="ghost-button"
        type="button"
        disabled={flow.busy || cooldown.remaining > 0}
        onClick={() => void resend()}
      >
        {cooldown.remaining > 0 ? `Resend in ${cooldown.remaining}s` : authLabels.resend}
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}
