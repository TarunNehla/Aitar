import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  describeAuthError,
  genericPasswordResetResult,
  genericSignUpResult,
  incorrectCredentials,
  providerLabels,
  requestPasswordReset,
  resetPasswordPath,
  retryAfterCollector,
  sendVerificationEmail,
  signIn,
  signUp,
  unverifiedEmailNotice,
  type SocialProvider,
} from "../auth-client";
import { Icon } from "./Icon";
import { PasswordInput } from "./PasswordInput";
import { Spinner } from "./Spinner";

type View = "sign-in" | "sign-up" | "forgot-password" | "notice";

interface Notice {
  heading: string;
  body: string;
  resendEmail: string | null;
}

const minPasswordLength = 8;
const maxPasswordLength = 128;
const resendCooldownSeconds = 30;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

export function describePasswordProblem(password: string, confirmation: string): {
  password?: string;
  confirmation?: string;
} {
  const problems: { password?: string; confirmation?: string } = {};
  if (password.length < minPasswordLength) problems.password = `Use at least ${minPasswordLength} characters`;
  else if (password.length > maxPasswordLength) problems.password = `Use at most ${maxPasswordLength} characters`;
  if (confirmation !== password) problems.confirmation = "Both passwords must match";
  return problems;
}

function TextField({
  label,
  value,
  type,
  autoComplete,
  disabled,
  error,
  onChange,
}: {
  label: string;
  value: string;
  type: "text" | "email";
  autoComplete: "name" | "email";
  disabled?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <div className="auth-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type={type}
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <small className="field-error" id={errorId}>{error}</small>}
    </div>
  );
}

function LinkedAccountHint() {
  return (
    <small className="auth-hint">
      <strong>Already use Google or GitHub with this email?</strong>
      {" "}
      Use “Forgot password” to create a password for the same Aitar account
    </small>
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

export function SignIn({ error, emailPassword = false }: { error?: string | null; emailPassword?: boolean }) {
  const [view, setView] = useState<View>("sign-in");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(error ?? null);

  function show(next: View) {
    setCallbackError(null);
    setView(next);
  }

  function showNotice(next: Notice) {
    setCallbackError(null);
    setNotice(next);
    setView("notice");
  }

  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Aitar</p>
        <h1>{view === "sign-up" ? "Create your account" : "Sign in to continue"}</h1>
        <p>Your repositories, chats, and checkpoints stay private to your account.</p>
      </div>

      {view === "sign-in" && (
        <SignInForm
          emailPassword={emailPassword}
          callbackError={callbackError}
          onForgotPassword={() => show("forgot-password")}
          onCreateAccount={() => show("sign-up")}
          onCallbackErrorCleared={() => setCallbackError(null)}
        />
      )}

      {view === "sign-up" && (
        <SignUpForm
          onSignedUp={(email) =>
            showNotice({ heading: "Check your email", body: genericSignUpResult, resendEmail: email })}
          onBack={() => show("sign-in")}
        />
      )}

      {view === "forgot-password" && (
        <ForgotPasswordForm
          onRequested={() =>
            showNotice({ heading: "Check your email", body: genericPasswordResetResult, resendEmail: null })}
          onBack={() => show("sign-in")}
        />
      )}

      {view === "notice" && notice && <NoticePanel notice={notice} onBack={() => show("sign-in")} />}
    </main>
  );
}

function SignInForm({
  emailPassword,
  callbackError,
  onForgotPassword,
  onCreateAccount,
  onCallbackErrorCleared,
}: {
  emailPassword: boolean;
  callbackError: string | null;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  onCallbackErrorCleared: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [socialPending, setSocialPending] = useState<SocialProvider | null>(null);
  const rememberId = useId();

  const busy = submitting || socialPending !== null;
  const message = formError ?? callbackError;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const trimmedEmail = email.trim();
    const problems: { email?: string; password?: string } = {};
    if (!looksLikeEmail(trimmedEmail)) problems.email = "Enter a valid email address";
    if (!password) problems.password = "Enter your password";
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setSubmitting(true);
    setFormError(null);
    setUnverified(null);
    onCallbackErrorCleared();

    const retry = retryAfterCollector();
    const result = await signIn.email({
      email: trimmedEmail,
      password,
      rememberMe,
      fetchOptions: retry.fetchOptions,
    });

    if (result.error) {
      setSubmitting(false);
      if (result.error.code === "EMAIL_NOT_VERIFIED") {
        setUnverified(trimmedEmail);
        setFormError(unverifiedEmailNotice);
        return;
      }
      // Unknown email and wrong password both arrive as 401, and stay indistinguishable here.
      setFormError(
        result.error.status === 401
          ? incorrectCredentials
          : describeAuthError(result.error, retry.state.seconds),
      );
    }
  }

  async function startSocial(provider: SocialProvider) {
    if (busy) return;
    setSocialPending(provider);
    setFormError(null);
    onCallbackErrorCleared();
    const result = await signIn.social({ provider, callbackURL: "/" });
    if (result?.error) {
      setSocialPending(null);
      setFormError(result.error.message ?? `${providerLabels[provider]} sign-in did not start`);
    }
  }

  return (
    <div className="setup-form framed auth-form">
      {emailPassword && (
        <>
          <form className="auth-fields" onSubmit={submit} noValidate>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              disabled={busy}
              error={fieldErrors.email}
              onChange={setEmail}
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              error={fieldErrors.password}
              onChange={setPassword}
            />

            <div className="auth-row">
              <label className="auth-checkbox" htmlFor={rememberId}>
                <input
                  id={rememberId}
                  type="checkbox"
                  checked={rememberMe}
                  disabled={busy}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                Remember me
              </label>
              <button className="link-button" type="button" disabled={busy} onClick={onForgotPassword}>
                Forgot password?
              </button>
            </div>

            <button className="primary-button auth-submit" type="submit" disabled={busy}>
              {submitting ? <Spinner size={16} /> : null}
              Sign in
            </button>
          </form>

        </>
      )}

      {message && <div className="form-error" role="alert">{message}</div>}
      {emailPassword && unverified && <ResendVerification email={unverified} />}

      {emailPassword && <div className="auth-divider"><span>or continue with</span></div>}

      <div className="provider-buttons">
        {(["google", "github"] as const).map((provider) => (
          <button
            className="ghost-button provider-button"
            key={provider}
            type="button"
            disabled={busy}
            onClick={() => void startSocial(provider)}
          >
            {socialPending === provider ? <Spinner size={16} /> : <Icon name="arrow-right" size={16} />}
            Continue with {providerLabels[provider]}
          </button>
        ))}
      </div>

      {emailPassword ? (
        <>
          <div className="auth-footer">
            New to Aitar?{" "}
            <button className="link-button" type="button" disabled={busy} onClick={onCreateAccount}>
              Create an account
            </button>
          </div>
          <LinkedAccountHint />
        </>
      ) : (
        <small>Aitar only reads your name, email, and avatar from these providers</small>
      )}
    </div>
  );
}

function SignUpForm({ onSignedUp, onBack }: { onSignedUp: (email: string) => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
    confirmation?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const problems = {
      ...(trimmedName ? {} : { name: "Enter your name" }),
      ...(looksLikeEmail(trimmedEmail) ? {} : { email: "Enter a valid email address" }),
      ...describePasswordProblem(password, confirmation),
    };
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setSubmitting(true);
    setFormError(null);

    const retry = retryAfterCollector();
    const result = await signUp.email({
      name: trimmedName,
      email: trimmedEmail,
      password,
      callbackURL: "/",
      fetchOptions: retry.fetchOptions,
    });

    setSubmitting(false);
    if (result.error) {
      setFormError(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    onSignedUp(trimmedEmail);
  }

  return (
    <div className="setup-form framed auth-form">
      <form className="auth-fields" onSubmit={submit} noValidate>
        <TextField
          label="Name"
          type="text"
          autoComplete="name"
          value={name}
          disabled={submitting}
          error={fieldErrors.name}
          onChange={setName}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          disabled={submitting}
          error={fieldErrors.email}
          onChange={setEmail}
        />
        <PasswordInput
          label="Password"
          autoComplete="new-password"
          value={password}
          disabled={submitting}
          error={fieldErrors.password}
          onChange={setPassword}
        />
        <PasswordInput
          label="Confirm password"
          autoComplete="new-password"
          value={confirmation}
          disabled={submitting}
          error={fieldErrors.confirmation}
          onChange={setConfirmation}
        />

        <button className="primary-button auth-submit" type="submit" disabled={submitting}>
          {submitting ? <Spinner size={16} /> : null}
          Create account
        </button>
      </form>

      {formError && <div className="form-error" role="alert">{formError}</div>}

      <div className="auth-footer">
        Already have an account?{" "}
        <button className="link-button" type="button" disabled={submitting} onClick={onBack}>
          Sign in
        </button>
      </div>
    </div>
  );
}

function ForgotPasswordForm({ onRequested, onBack }: { onRequested: () => void; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedEmail = email.trim();
    if (!looksLikeEmail(trimmedEmail)) {
      setFieldError("Enter a valid email address");
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setFormError(null);

    const retry = retryAfterCollector();
    const result = await requestPasswordReset({
      email: trimmedEmail,
      redirectTo: `${window.location.origin}${resetPasswordPath}`,
      fetchOptions: retry.fetchOptions,
    });

    setSubmitting(false);
    // Anything other than throttling stays generic so the reply reveals no account state.
    if (result.error?.status === 429) {
      setFormError(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    onRequested();
  }

  return (
    <div className="setup-form framed auth-form">
      <form className="auth-fields" onSubmit={submit} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          disabled={submitting}
          error={fieldError}
          onChange={setEmail}
        />
        <button className="primary-button auth-submit" type="submit" disabled={submitting}>
          {submitting ? <Spinner size={16} /> : null}
          Send reset instructions
        </button>
      </form>

      {formError && <div className="form-error" role="alert">{formError}</div>}

      <div className="auth-footer">
        <button className="link-button" type="button" disabled={submitting} onClick={onBack}>
          Back to sign in
        </button>
      </div>

      <LinkedAccountHint />
    </div>
  );
}

function NoticePanel({ notice, onBack }: { notice: Notice; onBack: () => void }) {
  return (
    <div className="setup-form framed auth-form">
      <div className="auth-notice">
        <h2>{notice.heading}</h2>
        <p>{notice.body}</p>
      </div>

      {notice.resendEmail && <ResendVerification email={notice.resendEmail} />}

      <div className="auth-footer">
        <button className="link-button" type="button" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </div>
  );
}

function ResendVerification({ email }: { email: string }) {
  const cooldown = useCooldown();
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function resend() {
    if (sending || cooldown.remaining > 0) return;
    setSending(true);
    setStatus(null);

    const retry = retryAfterCollector();
    const result = await sendVerificationEmail({ email, callbackURL: "/", fetchOptions: retry.fetchOptions });

    setSending(false);
    cooldown.start();
    setStatus(
      result.error?.status === 429
        ? describeAuthError(result.error, retry.state.seconds)
        : "If that address needs verifying, a new link is on its way.",
    );
  }

  return (
    <div className="auth-resend">
      <button
        className="ghost-button"
        type="button"
        disabled={sending || cooldown.remaining > 0}
        onClick={() => void resend()}
      >
        {cooldown.remaining > 0 ? `Resend in ${cooldown.remaining}s` : "Resend verification email"}
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}
