import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

export interface GitHubInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  status: string;
}

export interface GitHubRepository {
  githubRepositoryId: number;
  name: string;
  fullName: string;
  ownerLogin: string;
  private: boolean;
  cloneUrl: string;
}

const statusMessages: Record<string, string> = {
  suspended: "Suspended on GitHub",
  deleted: "Removed on GitHub",
};

export function GitHubRepositoryPicker({
  notice,
  busy,
  onSelect,
}: {
  notice?: string | null;
  busy: boolean;
  onSelect: (input: { installation: GitHubInstallation; repository: GitHubRepository }) => Promise<void>;
}) {
  const [installations, setInstallations] = useState<GitHubInstallation[] | null>(null);
  const [selectedInstallationId, setSelectedInstallationId] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [appConfigured, setAppConfigured] = useState(true);

  const loadInstallations = useCallback(async () => {
    setError(null);
    setInstallations(null);
    try {
      const status = await api<{ appConfigured: boolean }>("/api/github/status");
      setAppConfigured(status.appConfigured);
      if (!status.appConfigured) {
        setInstallations([]);
        return;
      }
      const result = await api<{ installations: GitHubInstallation[] }>("/api/github/installations");
      setInstallations(result.installations);
      setSelectedInstallationId((current) => current ?? result.installations[0]?.installationId ?? null);
    } catch (reason) {
      setInstallations([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const loadRepositories = useCallback(async (installationId: number) => {
    setError(null);
    setRepositories(null);
    try {
      const result = await api<{ repositories: GitHubRepository[] }>(
        `/api/github/installations/${installationId}/repositories`,
      );
      setRepositories(result.repositories);
    } catch (reason) {
      setRepositories([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void loadInstallations();
  }, [loadInstallations]);

  const selected = installations?.find((entry) => entry.installationId === selectedInstallationId);

  useEffect(() => {
    if (!selected || selected.status !== "active") {
      setRepositories(null);
      return;
    }
    void loadRepositories(selected.installationId);
  }, [selected, loadRepositories]);

  async function startInstallation() {
    setConnecting(true);
    setError(null);
    try {
      const result = await api<{ url: string }>("/api/github/installations/start", { method: "POST" });
      window.location.assign(result.url);
    } catch (reason) {
      setConnecting(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (installations === null) {
    return (
      <div className="github-panel">
        <Spinner size={16} label="Loading GitHub installations…" />
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="github-panel">
        {!appConfigured ? (
          <div className="form-error">GitHub App not configured on this server</div>
        ) : (
          <div className="github-empty">
            <div className="empty-icon">
              <Icon name="folder-git-2" size={20} />
            </div>
            <p>No GitHub account connected</p>
            <button
              className="primary-button"
              type="button"
              disabled={connecting}
              onClick={() => void startInstallation()}
            >
              {connecting ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
              Connect GitHub
            </button>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="github-panel">
      {notice && <div className="github-notice">{notice}</div>}

      <div className="github-accounts-row">
        <div className="github-accounts">
          {installations.map((installation) => (
            <button
              className={`github-account ${installation.installationId === selectedInstallationId ? "selected" : ""}`}
              key={installation.installationId}
              type="button"
              onClick={() => setSelectedInstallationId(installation.installationId)}
            >
              <Icon name="folder-git-2" size={14} />
              <span>{installation.accountLogin}</span>
              {installation.status !== "active" && <small className="github-flag">{installation.status}</small>}
            </button>
          ))}
        </div>
        <button
          className="ghost-button"
          type="button"
          aria-label="Add repositories"
          title="Add repositories"
          disabled={connecting || !appConfigured}
          onClick={() => void startInstallation()}
        >
          {connecting ? <Spinner size={16} /> : <Icon name="plus" size={16} />}
        </button>
      </div>

      {selected && selected.status !== "active" && (
        <div className="form-error">
          {statusMessages[selected.status] ?? "This installation is unavailable"}
        </div>
      )}

      {error && (
        <div className="form-error">
          {error}
          <button
            className="link-button"
            type="button"
            onClick={() => (selected ? void loadRepositories(selected.installationId) : void loadInstallations())}
          >
            Retry
          </button>
        </div>
      )}

      {selected?.status === "active" && repositories === null && !error && (
        <Spinner size={16} label="Loading repositories…" />
      )}

      {repositories !== null && repositories.length === 0 && !error && selected?.status === "active" && (
        <div className="github-empty">
          <p>No repositories shared with Aitar</p>
          <button
            className="ghost-button"
            type="button"
            disabled={connecting}
            onClick={() => void startInstallation()}
          >
            <Icon name="plus" size={16} />
            Add repositories
          </button>
        </div>
      )}

      {repositories !== null && repositories.length > 0 && selected && (
        <ul className="github-repositories ds-scroll">
          {repositories.map((repository) => (
            <li key={repository.githubRepositoryId}>
              <button
                className="github-repository"
                type="button"
                disabled={busy}
                onClick={() => void onSelect({ installation: selected, repository })}
              >
                <span className="github-repository-name">{repository.fullName}</span>
                <span className={`github-visibility ${repository.private ? "private" : "public"}`}>
                  {repository.private ? "Private" : "Public"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
