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
import { ProviderIcon } from "./ProviderIcon";
import { RepositorySetup } from "./RepositorySetup";
import { Spinner } from "./Spinner";

const sources = ["github", "public"] as const;
type Source = (typeof sources)[number];

export const onboardingQuestion = "What would you like to work on?";

const sourceLabels: Record<Source, string> = {
  github: "Connect GitHub repository",
  public: "Open public repository URL",
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
  const [source, setSource] = useState<Source | null>(null);
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

  const choices: ReactNode = (
    <div className="source-choices">
      {sources.map((entry) => (
        <button className="source-choice" key={entry} type="button" onClick={() => setSource(entry)}>
          <span className="source-choice-mark">
            {entry === "github" ? <ProviderIcon provider="github" size={20} /> : <Icon name="globe" size={20} />}
          </span>
          <span className="source-choice-label">{sourceLabels[entry]}</span>
          <Icon name="chevron-right" size={16} />
        </button>
      ))}
      {error && <div className="form-error">{error}</div>}
    </div>
  );

  const step: ReactNode = source === "github" ? (
    <>
      <GitHubRepositoryPicker notice={installationNotice} busy={busy} onSelect={connectGithubRepository} />
      {stage && (
        <p className="setup-step active">
          <Spinner size={14} />
          {stage}
        </p>
      )}
      {(connectError ?? error) && <div className="form-error">{connectError ?? error}</div>}
    </>
  ) : (
    <RepositorySetup defaultModel={defaultModel} error={error} onCreated={onCreated} />
  );

  const body = source === null ? choices : step;
  const goBack = busy ? undefined : () => setSource(null);

  if (variant === "dialog") {
    return (
      <Dialog
        title={source === null ? onboardingQuestion : sourceLabels[source]}
        onBack={source === null ? undefined : goBack}
        onClose={busy ? undefined : onClose}
      >
        <div className="repository-connect">{body}</div>
      </Dialog>
    );
  }

  return (
    <main className="onboarding">
      <section className="onboarding-panel">
        <header className="onboarding-header">
          {source !== null && (
            <button className="icon-button" type="button" aria-label="Back" onClick={goBack}>
              <Icon name="arrow-left" size={16} />
            </button>
          )}
          <h1>{source === null ? onboardingQuestion : sourceLabels[source]}</h1>
        </header>
        <div className="repository-connect">{body}</div>
      </section>
    </main>
  );
}
