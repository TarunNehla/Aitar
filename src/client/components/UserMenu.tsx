import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  changePassword,
  describeAuthError,
  linkSocial,
  listAccounts,
  providerLabels,
  requestPasswordReset,
  resetPasswordPath,
  retryAfterCollector,
  signOut,
  useAuthMethods,
  type SocialProvider,
} from "../auth-client";
import { Icon } from "./Icon";
import { PasswordInput } from "./PasswordInput";
import { describePasswordProblem } from "./SignIn";
import { Spinner } from "./Spinner";

export interface SessionUser {
  id: string;
  name?: string | null;
  email: string;
  image?: string | null;
}

function initials(user: SessionUser): string {
  const source = (user.name ?? user.email).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<SocialProvider[] | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<SocialProvider | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const authMethods = useAuthMethods();

  const loadAccounts = useCallback(async () => {
    const result = await listAccounts();
    if (result.error) {
      setError("Connected accounts could not be loaded");
      return;
    }
    const accounts = result.data ?? [];
    const providers = accounts
      .map((account) => account.providerId)
      .filter((provider): provider is SocialProvider => provider === "google" || provider === "github");
    setConnected([...new Set(providers)]);
    setHasPassword(accounts.some((account) => account.providerId === "credential"));
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void loadAccounts();
  }, [open, loadAccounts]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function connect(provider: SocialProvider) {
    setBusy(provider);
    setError(null);
    const result = await linkSocial({ provider, callbackURL: "/" });
    if (result?.error) {
      setBusy(null);
      setError(result.error.message ?? `${providerLabels[provider]} could not be connected`);
    }
  }

  async function endSession() {
    setBusy("sign-out");
    await signOut();
    setBusy(null);
    setOpen(false);
    onSignedOut();
  }

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        className="user-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {user.image
          ? <img className="user-avatar-image" src={user.image} alt="" referrerPolicy="no-referrer" />
          : <span className="user-avatar-initials">{initials(user)}</span>}
        <span className="user-menu-name">{user.name || user.email}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-identity">
            {user.image
              ? <img className="user-avatar-image large" src={user.image} alt="" referrerPolicy="no-referrer" />
              : <span className="user-avatar-initials large">{initials(user)}</span>}
            <div className="user-menu-identity-text">
              <strong>{user.name || "Signed in"}</strong>
              <small>{user.email}</small>
            </div>
          </div>

          <div className="user-menu-section">
            <p className="eyebrow">Sign-in providers</p>
            {connected === null ? (
              <Spinner size={14} label="Loading providers…" />
            ) : (
              (["google", "github"] as const).map((provider) => {
                const isConnected = connected.includes(provider);
                return (
                  <div className="user-menu-provider" key={provider}>
                    <span className="user-menu-provider-name">{providerLabels[provider]}</span>
                    {isConnected ? (
                      <span className="provider-connected">
                        <Icon name="check" size={14} />
                        Connected
                      </span>
                    ) : (
                      <button
                        className="link-button"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void connect(provider)}
                      >
                        {busy === provider ? "Connecting…" : "Connect"}
                      </button>
                    )}
                  </div>
                );
              })
            )}
            <small className="user-menu-hint">
              Connecting GitHub here signs you in. Repository access is granted separately
            </small>
          </div>

          {authMethods?.emailPassword && (
            <div className="user-menu-section">
              <p className="eyebrow">Password</p>
              {hasPassword === null ? (
                <Spinner size={14} label="Loading password settings…" />
              ) : hasPassword ? (
                <ChangePasswordForm disabled={busy !== null} />
              ) : (
                <CreatePasswordAction email={user.email} disabled={busy !== null} />
              )}
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <button
            className="user-menu-action"
            type="button"
            role="menuitem"
            disabled={busy !== null}
            onClick={() => void endSession()}
          >
            <Icon name="x" size={16} />
            {busy === "sign-out" ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

function ChangePasswordForm({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmation?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirmation("");
    setFieldErrors({});
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const problems = describePasswordProblem(next, confirmation);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setSubmitting(true);
    setMessage(null);

    const retry = retryAfterCollector();
    const result = await changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
      fetchOptions: retry.fetchOptions,
    });

    setSubmitting(false);
    reset();
    if (result.error) {
      setFailed(true);
      setMessage(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    setFailed(false);
    setMessage("Password updated. Your other sessions were signed out");
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="user-menu-password">
        <button
          className="link-button"
          type="button"
          disabled={disabled}
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
        >
          Change password
        </button>
        {message && <small className={failed ? "field-error" : "user-menu-hint"} role="status">{message}</small>}
      </div>
    );
  }

  return (
    <form className="user-menu-password auth-fields" onSubmit={submit} noValidate>
      <PasswordInput
        label="Current password"
        autoComplete="current-password"
        value={current}
        disabled={submitting}
        onChange={setCurrent}
      />
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        value={next}
        disabled={submitting}
        error={fieldErrors.password}
        onChange={setNext}
      />
      <PasswordInput
        label="Confirm new password"
        autoComplete="new-password"
        value={confirmation}
        disabled={submitting}
        error={fieldErrors.confirmation}
        onChange={setConfirmation}
      />

      {message && failed && <div className="form-error" role="alert">{message}</div>}

      <div className="user-menu-password-actions">
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Update password"}
        </button>
        <button
          className="link-button"
          type="button"
          disabled={submitting}
          onClick={() => {
            reset();
            setMessage(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * A social-only account has no current password to prove, so the password is set
 * through the emailed reset link rather than a form that could never succeed.
 */
function CreatePasswordAction({ email, disabled }: { email: string; disabled: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function start() {
    if (sending) return;
    setSending(true);
    setMessage(null);

    const retry = retryAfterCollector();
    const result = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}${resetPasswordPath}`,
      fetchOptions: retry.fetchOptions,
    });

    setSending(false);
    setMessage(
      result.error?.status === 429
        ? describeAuthError(result.error, retry.state.seconds)
        : "Check your email for a link to set a password",
    );
  }

  return (
    <div className="user-menu-password">
      <button className="link-button" type="button" disabled={disabled || sending} onClick={() => void start()}>
        {sending ? "Sending…" : "Create a password"}
      </button>
      <small className="user-menu-hint">
        Aitar emails a link so the password is set after proving you can read this address
      </small>
      {message && <small className="user-menu-hint" role="status">{message}</small>}
    </div>
  );
}
