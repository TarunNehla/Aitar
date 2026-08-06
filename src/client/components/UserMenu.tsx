import { useCallback, useEffect, useRef, useState } from "react";
import { linkSocial, listAccounts, providerLabels, signOut, type SocialProvider } from "../auth-client";
import { Icon } from "./Icon";
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
  const [busy, setBusy] = useState<SocialProvider | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadAccounts = useCallback(async () => {
    const result = await listAccounts();
    if (result.error) {
      setError("Connected accounts could not be loaded");
      return;
    }
    const providers = (result.data ?? [])
      .map((account) => account.providerId)
      .filter((provider): provider is SocialProvider => provider === "google" || provider === "github");
    setConnected([...new Set(providers)]);
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
