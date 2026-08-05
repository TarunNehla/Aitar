import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageView, SessionEvent } from "../shared/contracts";
import { api } from "./api";

interface SessionListItem {
  session: { id: string; title: string; workspaceId: string; defaultModel: string; status: string };
  workspace: { id: string; name: string; status: string };
  project: { id: string; name: string; repositoryUrl: string };
}

interface Run {
  id: string;
  status: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface Artifact {
  id: string;
  name: string;
  type: string;
  size: number;
  metadata: Record<string, unknown>;
}

interface Approval {
  id: string;
  reason: string;
  command: string | null;
}

interface SessionDetail extends SessionListItem {
  messages: MessageView[];
  runs: Run[];
  artifacts: Artifact[];
  approvals: Approval[];
}

const activeStatuses = new Set(["pending", "running", "waiting_for_approval", "cancelling"]);

function messageText(message: MessageView): string {
  return message.blocks
    .filter((block) => message.role === "tool" || block.visibility === "user" || block.visibility === "both")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export function App() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldFollowMessagesRef = useRef(true);
  const renderedSessionRef = useRef<string | null>(null);

  const loadSessions = useCallback(async () => {
    const result = await api<{ sessions: SessionListItem[] }>("/api/sessions");
    setSessions(result.sessions);
    setSelectedId((current) => current ?? result.sessions[0]?.session.id ?? null);
    return result.sessions;
  }, []);

  const loadDetail = useCallback(async (sessionId: string) => {
    const result = await api<SessionDetail>(`/api/sessions/${sessionId}`);
    setDetail(result);
  }, []);

  useEffect(() => {
    loadSessions()
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetail((current) => current?.session.id === selectedId ? current : null);
    setEvents([]);
    setStreamingText("");
    shouldFollowMessagesRef.current = true;
    renderedSessionRef.current = null;
    loadDetail(selectedId).catch((reason) => setError(reason.message));

    const source = new EventSource(`/api/sessions/${selectedId}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent;
      setEvents((current) => [...current, event].slice(-300));

      if (event.type === "assistant_text_delta") {
        setStreamingText((current) => current + String(event.payload.delta ?? ""));
      }

      if (
        [
          "assistant_message_completed",
          "run_completed",
          "run_failed",
          "approval_requested",
          "approval_resolved",
          "artifact_created",
        ].includes(event.type)
      ) {
        if (event.type === "assistant_message_completed") setStreamingText("");
        void loadDetail(selectedId);
        void loadSessions();
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically using the last event ID.
    };
    return () => source.close();
  }, [selectedId, loadDetail, loadSessions]);

  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (!messages || !detail || detail.session.id !== selectedId) return;

    const changedSession = renderedSessionRef.current !== detail.session.id;
    if (changedSession) {
      renderedSessionRef.current = detail.session.id;
      shouldFollowMessagesRef.current = true;
    }

    if (changedSession || shouldFollowMessagesRef.current) {
      messages.scrollTop = messages.scrollHeight;
    }
  }, [detail, selectedId, streamingText]);

  const activeRun = useMemo(() => detail?.runs.find((run) => activeStatuses.has(run.status)), [detail]);

  if (loading) return <div className="center-state">Opening Cloud Agents…</div>;

  if (sessions.length === 0) {
    return (
      <Onboarding
        error={error}
        onCreated={async (sessionId) => {
          await loadSessions();
          setSelectedId(sessionId);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>Cloud Agents</strong>
            <small>Private workspace</small>
          </div>
        </div>

        <div className="session-list">
          <p className="eyebrow">Sessions</p>
          {sessions.map((item) => (
            <button
              className={`session-button ${item.session.id === selectedId ? "selected" : ""}`}
              key={item.session.id}
              onClick={() => setSelectedId(item.session.id)}
            >
              <span>{item.session.title}</span>
              <small>{item.project.name}</small>
            </button>
          ))}
        </div>

        {detail && (
          <button
            className="new-session"
            onClick={async () => {
              const result = await api<{ session: { id: string } }>(
                `/api/workspaces/${detail.workspace.id}/sessions`,
                { method: "POST", body: JSON.stringify({ title: "New session", model: detail.session.defaultModel }) },
              );
              await loadSessions();
              setSelectedId(result.session.id);
            }}
          >
            + New session
          </button>
        )}
      </aside>

      <main className="conversation">
        {detail ? (
          <>
            <header className="conversation-header">
              <div>
                <h1>{detail.session.title}</h1>
                <a href={detail.project.repositoryUrl} target="_blank" rel="noreferrer">
                  {detail.project.name} ↗
                </a>
              </div>
              <div className={`run-state ${activeRun ? "working" : "ready"}`}>
                <span />
                {activeRun ? activeRun.status.replaceAll("_", " ") : "Ready"}
              </div>
            </header>

            <div
              className="messages"
              ref={messagesRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                shouldFollowMessagesRef.current = distanceFromBottom < 80;
              }}
            >
              {detail.messages.length === 0 && (
                <div className="empty-chat">
                  <div className="empty-icon">⌁</div>
                  <h2>What should the agent build?</h2>
                  <p>The agent can inspect files, edit code, run commands, and test its work.</p>
                </div>
              )}

              {detail.messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}

              {streamingText && (
                <div className="message assistant-message streaming">
                  <div className="avatar">A</div>
                  <div className="message-body markdown-content">
                    <MarkdownText>{streamingText}</MarkdownText>
                    <span className="cursor" />
                  </div>
                </div>
              )}
            </div>

            <Composer
              working={Boolean(activeRun)}
              onCancel={activeRun ? () => api(`/api/runs/${activeRun.id}/cancel`, { method: "POST" }) : undefined}
              onSend={async (text) => {
                setError(null);
                shouldFollowMessagesRef.current = true;
                try {
                  await api(`/api/sessions/${detail.session.id}/messages`, {
                    method: "POST",
                    body: JSON.stringify({ text }),
                  });
                  await loadDetail(detail.session.id);
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                  throw reason;
                }
              }}
            />
            {error && <div className="toast">{error}</div>}
          </>
        ) : (
          <div className="center-state">Loading session…</div>
        )}
      </main>

      <aside className="activity-panel">
        <div className="panel-section">
          <p className="eyebrow">Live activity</p>
          <Activity events={events} />
        </div>

        <div className="panel-section artifacts-section">
          <p className="eyebrow">Artifacts</p>
          {detail?.artifacts.length ? (
            detail.artifacts.map((artifact) => (
              <a className="artifact" href={`/api/artifacts/${artifact.id}`} target="_blank" key={artifact.id}>
                <span className="artifact-icon">↗</span>
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{formatBytes(artifact.size)}</small>
                </span>
              </a>
            ))
          ) : (
            <p className="muted">Artifacts appear when a run finishes.</p>
          )}
        </div>

        {detail?.approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            onResolve={async (approved) => {
              await api(`/api/approvals/${approval.id}`, {
                method: "POST",
                body: JSON.stringify({ approved }),
              });
              await loadDetail(detail.session.id);
            }}
          />
        ))}
      </aside>
    </div>
  );
}

function Message({ message }: { message: MessageView }) {
  if (message.role === "tool") {
    const block = message.blocks[0];
    if (block?.data.toolName === "finish") {
      return (
        <div className="message assistant-message">
          <div className="avatar">A</div>
          <div className="message-body markdown-content">
            <MarkdownText>{messageText(message)}</MarkdownText>
          </div>
        </div>
      );
    }
    return (
      <details className="tool-message">
        <summary>{String(block?.data.toolName ?? "Tool")} completed</summary>
        <pre>{messageText(message)}</pre>
      </details>
    );
  }

  return (
    <div className={`message ${message.role === "user" ? "user-message" : "assistant-message"} ${message.status === "queued" ? "queued" : ""}`}>
      {message.role === "assistant" && <div className="avatar">A</div>}
      {message.role === "assistant" ? (
        <div className="message-body markdown-content">
          <MarkdownText>{messageText(message)}</MarkdownText>
        </div>
      ) : (
        <div className="message-body">{messageText(message)}</div>
      )}
    </div>
  );
}

function MarkdownText({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkText, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {linkText}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function Composer({
  working,
  onSend,
  onCancel,
}: {
  working: boolean;
  onSend: (text: string) => Promise<void>;
  onCancel?: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await onSend(text.trim());
      setText("");
    } catch {
      // The parent shows the request error and keeps the draft for retry.
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={working ? "Send guidance while the agent works…" : "Ask the agent to change the repository…"}
        rows={2}
      />
      {onCancel && (
        <button className="cancel-button" type="button" onClick={() => void onCancel()}>
          Stop
        </button>
      )}
      <button className="send-button" type="submit" disabled={!text.trim() || sending}>
        ↑
      </button>
      <small>Enter to send · Shift + Enter for a new line</small>
    </form>
  );
}

function Activity({ events }: { events: SessionEvent[] }) {
  const visible = events.filter((event) => !event.type.includes("delta")).slice(-12).reverse();
  if (!visible.length) return <p className="muted">Waiting for activity.</p>;

  return (
    <div className="activity-list">
      {visible.map((event) => (
        <div className="activity-row" key={event.id}>
          <span className={`event-dot ${event.type.includes("failed") ? "error" : ""}`} />
          <div>
            <strong>{event.type.replaceAll("_", " ")}</strong>
            <small>{event.type === "tool_started" ? String(event.payload.toolName ?? "") : ""}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: (approved: boolean) => Promise<void> }) {
  return (
    <div className="approval-card">
      <p className="eyebrow">Approval needed</p>
      <strong>{approval.reason}</strong>
      {approval.command && <code>{approval.command}</code>}
      <div>
        <button onClick={() => void onResolve(false)}>Deny</button>
        <button className="approve" onClick={() => void onResolve(true)}>Allow once</button>
      </div>
    </div>
  );
}

function Onboarding({ error, onCreated }: { error: string | null; onCreated: (sessionId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setLocalError(null);
    const data = new FormData(event.currentTarget);
    try {
      const projectResult = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), repositoryUrl: data.get("repositoryUrl") }),
      });
      const workspaceResult = await api<{ workspace: { id: string } }>(
        `/api/projects/${projectResult.project.id}/workspaces`,
        {
          method: "POST",
          body: JSON.stringify({ name: "Main workspace", baseBranch: data.get("baseBranch") }),
        },
      );
      const sessionResult = await api<{ session: { id: string } }>(
        `/api/workspaces/${workspaceResult.workspace.id}/sessions`,
        {
          method: "POST",
          body: JSON.stringify({ title: "First session", model: data.get("model") }),
        },
      );
      await onCreated(sessionResult.session.id);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <span className="logo-large">C</span>
        <p className="eyebrow">Cloud Agents V0</p>
        <h1>Your coding agent.<br />Running in the cloud.</h1>
        <p>Connect a public repository and start an ongoing coding session.</p>
      </div>
      <form className="setup-card" onSubmit={submit}>
        <h2>Connect a repository</h2>
        <label>Project name<input name="name" placeholder="My application" required /></label>
        <label>GitHub repository<input name="repositoryUrl" type="url" placeholder="https://github.com/owner/repository" required /></label>
        <div className="field-row">
          <label>Base branch<input name="baseBranch" defaultValue="main" required /></label>
          <label>OpenRouter model<input name="model" defaultValue="deepseek/deepseek-v4-flash-0731" required /></label>
        </div>
        <button type="submit" disabled={busy}>{busy ? "Preparing workspace…" : "Create workspace"}</button>
        <small>V0 supports public GitHub repositories.</small>
        {(localError ?? error) && <div className="form-error">{localError ?? error}</div>}
      </form>
    </main>
  );
}
