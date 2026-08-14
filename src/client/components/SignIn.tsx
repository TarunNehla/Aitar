import { useState } from "react";
import { providerLabels, signIn, type SocialProvider } from "../auth-client";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

export function SignIn({ error }: { error?: string | null }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const message = localError ?? error ?? null;

  async function start(provider: SocialProvider) {
    if (pending) return;
    setPending(provider);
    setLocalError(null);
    const result = await signIn.social({ provider, callbackURL: "/" });
    if (result?.error) {
      setPending(null);
      setLocalError(result.error.message ?? `${providerLabels[provider]} sign-in did not start`);
    }
  }

  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Aitar</p>
        <h1>Sign in to continue</h1>
        <p>Your repositories, chats, and checkpoints stay private to your account.</p>
      </div>

      <div className="setup-form framed">
        <div className="provider-buttons">
          {(["google", "github"] as const).map((provider) => (
            <button
              className="ghost-button provider-button"
              key={provider}
              type="button"
              disabled={pending !== null}
              onClick={() => void start(provider)}
            >
              {pending === provider ? <Spinner size={16} /> : <Icon name="arrow-right" size={16} />}
              Continue with {providerLabels[provider]}
            </button>
          ))}
        </div>

        {message && <div className="form-error">{message}</div>}

        <small>Aitar only reads your name, email, and avatar from these providers</small>
      </div>
    </main>
  );
}
