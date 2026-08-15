import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { describeSetupError, repositoryNameFromUrl, repositoryUrlError } from "../repository";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

const fallbackModel = "deepseek/deepseek-v4-flash-0731";
const stages = ["repository", "chat", "opening"] as const;
type Stage = (typeof stages)[number];

const stageLabels: Record<Stage, string> = {
  repository: "Cloning the repository…",
  chat: "Preparing the workspace…",
  opening: "Opening the chat…",
};

export function RepositorySetup({
  defaultModel,
  error,
  onCreated,
}: {
  defaultModel?: string;
  error?: string | null;
  onCreated: (sessionId: string) => Promise<void>;
}) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [model, setModel] = useState(defaultModel ?? fallbackModel);
  const [stage, setStage] = useState<Stage | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const nameEditedRef = useRef(false);
  const repositoryIdRef = useRef<string | null>(null);
  const busy = stage !== null;
  const message = localError ?? error ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const url = repositoryUrl.trim();
    const branch = baseBranch.trim() || "main";
    const invalid = repositoryUrlError(url);
    if (invalid) {
      setLocalError(invalid);
      return;
    }

    setLocalError(null);
    setStage("repository");
    try {
      if (!repositoryIdRef.current) {
        const created = await api<{ repository: { id: string } }>("/api/repositories", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim() || repositoryNameFromUrl(url),
            repositoryUrl: url,
            defaultBranch: branch,
          }),
        });
        repositoryIdRef.current = created.repository.id;
      }

      setStage("chat");
      const session = await api<{ session: { id: string } }>(
        `/api/repositories/${repositoryIdRef.current}/chats`,
        {
          method: "POST",
          body: JSON.stringify({ title: "New session", model: model.trim(), baseBranch: branch }),
        },
      );

      setStage("opening");
      await onCreated(session.session.id);
    } catch (reason) {
      setStage(null);
      setLocalError(describeSetupError(reason, branch));
    }
  }

  return (
    <form className="setup-form" onSubmit={submit}>
      <label>
        <span>Repository URL</span>
        <input
          name="repositoryUrl"
          value={repositoryUrl}
          onChange={(event) => {
            setRepositoryUrl(event.target.value);
            if (!nameEditedRef.current) setName(repositoryNameFromUrl(event.target.value));
          }}
          placeholder="https://github.com/owner/repository"
          disabled={busy}
          autoFocus
          required
        />
      </label>

      <details className="setup-options">
        <summary>
          <Icon name="chevron-right" size={14} />
          Options
        </summary>
        <div className="setup-options-body">
          <label>
            <span>Name</span>
            <input
              name="name"
              value={name}
              onChange={(event) => {
                nameEditedRef.current = true;
                setName(event.target.value);
              }}
              placeholder="My application"
              disabled={busy}
              required
            />
          </label>
          <div className="field-row">
            <label>
              <span>Base branch</span>
              <input
                name="baseBranch"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label>
              <span>Model</span>
              <input
                name="model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={busy}
                required
              />
            </label>
          </div>
        </div>
      </details>

      {stage && (
        <p className="setup-step active">
          <Spinner size={14} />
          {stageLabels[stage]}
        </p>
      )}

      {message && <div className="form-error">{message}</div>}

      <div className="setup-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          Open repository
        </button>
      </div>
    </form>
  );
}
