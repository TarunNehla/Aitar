import { useState, type ReactNode } from "react";
import { api } from "../api";
import { describeSetupError } from "../repository";
import { Dialog } from "./Dialog";
import {
  GitHubRepositoryPicker,
  type GitHubInstallation,
  type GitHubRepository,
} from "./GitHubRepositoryPicker";
import { Icon } from "./Icon";
import { RepositorySetup } from "./RepositorySetup";
import { Spinner } from "./Spinner";

const sources = ["github", "public"] as const;
type Source = (typeof sources)[number];

const sourceLabels: Record<Source, string> = {
  github: "GitHub repositories",
  public: "Public URL",
};

export function RepositoryConnect({
  variant,
  defaultModel,
  error,
  installationNotice,
  onCreated,
  onClose,
}: {
  variant: "page" | "dialog";
  defaultModel?: string;
  error?: string | null;
  installationNotice?: string | null;
  onCreated: (sessionId: string) => Promise<void>;
  onClose?: () => void;
}) {
  const [source, setSource] = useState<Source>("github");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connectGithubRepository(input: {
    installation: GitHubInstallation;
    repository: GitHubRepository;
  }) {
    if (busy) return;
    setBusy(true);
    setConnectError(null);
    setStage("Preparing the repository…");
    try {
      const created = await api<{ repository: { id: string; defaultBranch: string } }>("/api/repositories", {
        method: "POST",
        body: JSON.stringify({
          installationId: input.installation.installationId,
          githubRepositoryId: input.repository.githubRepositoryId,
          name: input.repository.name,
          defaultBranch: input.repository.defaultBranch,
        }),
      });

      setStage("Preparing the workspace…");
      const session = await api<{ session: { id: string } }>(
        `/api/repositories/${created.repository.id}/chats`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "New session",
            ...(defaultModel ? { model: defaultModel } : {}),
            baseBranch: created.repository.defaultBranch,
          }),
        },
      );

      setStage("Opening the chat…");
      await onCreated(session.session.id);
    } catch (reason) {
      setConnectError(describeSetupError(reason, input.repository.defaultBranch));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const body: ReactNode = (
    <div className="repository-connect">
      <div className="source-switch" role="tablist">
        {sources.map((entry) => (
          <button
            className={`source-tab ${entry === source ? "selected" : ""}`}
            key={entry}
            role="tab"
            aria-selected={entry === source}
            type="button"
            disabled={busy}
            onClick={() => setSource(entry)}
          >
            {sourceLabels[entry]}
          </button>
        ))}
      </div>

      {source === "github" ? (
        <>
          <GitHubRepositoryPicker
            notice={installationNotice}
            busy={busy}
            onSelect={connectGithubRepository}
          />
          {stage && (
            <p className="setup-step active">
              <Spinner size={14} />
              {stage}
            </p>
          )}
          {(connectError ?? error) && <div className="form-error">{connectError ?? error}</div>}
        </>
      ) : (
        <RepositorySetup
          variant="embedded"
          defaultModel={defaultModel}
          error={error}
          onCreated={onCreated}
        />
      )}
    </div>
  );

  if (variant === "dialog") {
    return (
      <Dialog
        title="New repository"
        description="Connect a repository through the GitHub App, or clone a public URL"
        onClose={busy ? undefined : onClose}
      >
        {body}
      </Dialog>
    );
  }

  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Cloud Agents</p>
        <h1>Connect a repository</h1>
        <p>The agent works on a branch in your repository and reports back here.</p>
      </div>
      <div className="setup-form framed">
        <div className="connect-heading">
          <Icon name="folder-git-2" size={20} />
          <strong>Choose a source</strong>
        </div>
        {body}
      </div>
    </main>
  );
}
