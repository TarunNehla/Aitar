import { useState, type FormEvent } from "react";
import { describeAuthError, resetPassword, retryAfterCollector } from "../auth-client";
import { PasswordInput } from "./PasswordInput";
import { Spinner } from "./Spinner";
import { describePasswordProblem } from "./SignIn";

export function ResetPassword({ token, onDone }: { token: string | null; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmation?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !token) return;

    const problems = describePasswordProblem(password, confirmation);
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setSubmitting(true);
    setFormError(null);

    const retry = retryAfterCollector();
    const result = await resetPassword({ newPassword: password, token, fetchOptions: retry.fetchOptions });

    setSubmitting(false);
    setPassword("");
    setConfirmation("");
    if (result.error) {
      setFormError(describeAuthError(result.error, retry.state.seconds));
      return;
    }
    setDone(true);
  }

  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Aitar</p>
        <h1>Choose a new password</h1>
        <p>Signing in with the new password ends every other Aitar session.</p>
      </div>

      <div className="setup-form framed auth-form">
        {done ? (
          <div className="auth-notice">
            <h2>Password updated</h2>
            <p>Your other sessions were signed out.</p>
          </div>
        ) : !token ? (
          <div className="auth-notice">
            <h2>That link is incomplete</h2>
            <p>Open the most recent reset email, or request a new link from the sign-in screen.</p>
          </div>
        ) : (
          <>
            <form className="auth-fields" onSubmit={submit} noValidate>
              <PasswordInput
                label="New password"
                autoComplete="new-password"
                value={password}
                disabled={submitting}
                error={fieldErrors.password}
                onChange={setPassword}
              />
              <PasswordInput
                label="Confirm new password"
                autoComplete="new-password"
                value={confirmation}
                disabled={submitting}
                error={fieldErrors.confirmation}
                onChange={setConfirmation}
              />
              <button className="primary-button auth-submit" type="submit" disabled={submitting}>
                {submitting ? <Spinner size={16} /> : null}
                Set new password
              </button>
            </form>

            {formError && <div className="form-error" role="alert">{formError}</div>}
          </>
        )}

        <div className="auth-footer">
          <button className="link-button" type="button" onClick={onDone}>
            {done ? "Sign in with your new password" : "Back to sign in"}
          </button>
        </div>
      </div>
    </main>
  );
}
