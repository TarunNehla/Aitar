import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodeChanges, FileChange, MessageView, SessionEvent } from "../shared/contracts";
import { api } from "./api";

interface Repository {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
}

interface SessionListItem {
  session: {
    id: string;
    title: string;
    repositoryId: string;
    defaultModel: string;
    status: string;
    branchName: string;
    baseBranch: string;
    baseCommit: string | null;
    headCommit: string | null;
    envStatus: string;
  };
  repository: Repository;
}

interface Run {
  id: string;
  status: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface Approval {
  id: string;
  reason: string;
  command: string | null;
}

type TimelineItem =
  | { kind: "message"; id: string; createdAt: string; message: MessageView }
  | { kind: "event"; id: string; createdAt: string; event: SessionEvent; reasoningCompleted: boolean; changeCommit?: string };

interface SessionDetail extends SessionListItem {
  messages: MessageView[];
  runs: Run[];
  approvals: Approval[];
}

const activeStatuses = new Set(["pending", "running", "waiting_for_approval", "cancelling"]);
const liveOutputLimit = 100_000;

function messageText(message: MessageView): string {
  return message.blocks
    .filter((block) => message.role === "tool" || block.visibility === "user" || block.visibility === "both")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n");
}

function toolLabel(value: unknown): string {
  return String(value ?? "Tool").replaceAll("_", " ");
}

function buildTimeline(messages: MessageView[], events: SessionEvent[]): TimelineItem[] {
  const completedToolCalls = new Set(
    messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.blocks.map((block) => String(block.data.callId ?? "")))
      .filter(Boolean),
  );
  const reasoningCompletions = events.filter((event) => event.type === "reasoning_completed");
  const visibleTypes = new Set([
    "run_started",
    "run_completed",
    "run_failed",
    "reasoning_started",
    "tool_started",
    "file_changed",
    "checkpoint_saved",
    "approval_requested",
    "approval_resolved",
  ]);

  const timeline: TimelineItem[] = messages.map((message) => ({
    kind: "message",
    id: `message-${message.id}`,
    createdAt: message.createdAt,
    message,
  }));
  const seenCheckpointCommits = new Set<string>();

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (!visibleTypes.has(event.type)) continue;
    if (event.type === "tool_started" && completedToolCalls.has(String(event.payload.callId ?? ""))) continue;
    const commit = event.type === "checkpoint_saved" ? String(event.payload.commit ?? "") : "";
    const changedFileCount = Number(
      event.payload.changedFileCount ??
      (Array.isArray(event.payload.changedFiles) ? event.payload.changedFiles.length : 0),
    );
    if (
      event.type === "checkpoint_saved" &&
      (!commit || changedFileCount === 0 || event.payload.createdCommit === false || seenCheckpointCommits.has(commit))
    ) {
      continue;
    }
    if (commit) seenCheckpointCommits.add(commit);
    const reasoningCompleted =
      event.type === "reasoning_started" &&
      reasoningCompletions.some(
        (completion) => completion.runId === event.runId && completion.sequence > event.sequence,
      );
    timeline.push({
      kind: "event",
      id: `event-${event.id}`,
      createdAt: event.createdAt,
      event,
      reasoningCompleted,
      ...(commit ? { changeCommit: commit } : {}),
    });
  }

  return timeline.sort((left, right) => {
    const timeDifference = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (timeDifference !== 0) return timeDifference;
    if (left.kind === "event" && right.kind === "event") return left.event.sequence - right.event.sequence;
    return left.kind === "message" ? -1 : 1;
  });
}

export function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [changesByCommit, setChangesByCommit] = useState<Record<string, CodeChanges>>({});
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [liveToolOutput, setLiveToolOutput] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldFollowMessagesRef = useRef(true);
  const renderedSessionRef = useRef<string | null>(null);
  const requestedChangesRef = useRef(new Set<string>());
  const selectedSessionRef = useRef<string | null>(null);
  const eventReplayReadyRef = useRef(false);
  selectedSessionRef.current = selectedId;

  const loadSessions = useCallback(async () => {
    const result = await api<{ sessions: SessionListItem[] }>("/api/sessions");
    setSessions(result.sessions);
    setSelectedId((current) => current ?? result.sessions[0]?.session.id ?? null);
    return result.sessions;
  }, []);

  const loadRepositories = useCallback(async () => {
    const result = await api<{ repositories: Repository[] }>("/api/repositories");
    setRepositories(result.repositories);
    return result.repositories;
  }, []);

  const loadDetail = useCallback(async (sessionId: string) => {
    const result = await api<SessionDetail>(`/api/sessions/${sessionId}`);
    setDetail(result);
  }, []);

  useEffect(() => {
    Promise.all([loadRepositories(), loadSessions()])
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [loadRepositories, loadSessions]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setChangesByCommit({});
      requestedChangesRef.current.clear();
      return;
    }
    setDetail((current) => current?.session.id === selectedId ? current : null);
    setChangesByCommit({});
    requestedChangesRef.current.clear();
    setEvents([]);
    setStreamingText("");
    setLiveToolOutput({});
    eventReplayReadyRef.current = false;
    shouldFollowMessagesRef.current = true;
    renderedSessionRef.current = null;
    loadDetail(selectedId).catch((reason) => setError(reason.message));

    const source = new EventSource(`/api/sessions/${selectedId}/events`);
    source.addEventListener("ready", () => {
      eventReplayReadyRef.current = true;
    });
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent;
      if (event.transient && ["stdout_chunk", "stderr_chunk"].includes(event.type)) {
        const callId = String(event.payload.callId ?? "");
        const chunk = String(event.payload.chunk ?? "");
        if (callId && chunk) {
          setLiveToolOutput((current) => {
            const combined = `${current[callId] ?? ""}${chunk}`;
            return { ...current, [callId]: combined.slice(-liveOutputLimit) };
          });
        }
        return;
      }
      setEvents((current) => {
        if (current.some((candidate) => candidate.id === event.id)) return current;
        return [...current, event].slice(-300);
      });

      if (eventReplayReadyRef.current && event.type === "assistant_text_delta") {
        setStreamingText((current) => current + String(event.payload.delta ?? ""));
      }

      if (
        eventReplayReadyRef.current &&
        [
          "assistant_message_completed",
          "tool_completed",
          "run_completed",
          "run_failed",
          "approval_requested",
          "approval_resolved",
        ].includes(event.type)
      ) {
        if (event.type === "assistant_message_completed") setStreamingText("");
        if (event.type === "tool_completed") {
          const callId = String(event.payload.callId ?? "");
          setLiveToolOutput((current) => {
            const next = { ...current };
            delete next[callId];
            return next;
          });
        }
        void loadDetail(selectedId);
        void loadSessions();
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically using the last event ID.
    };
    return () => source.close();
  }, [selectedId, loadDetail, loadSessions]);

  const timeline = useMemo(
    () => buildTimeline(detail?.messages ?? [], events),
    [detail?.messages, events],
  );
  const checkpointCommits = useMemo(
    () => timeline.flatMap((item) => item.kind === "event" && item.changeCommit ? [item.changeCommit] : []),
    [timeline],
  );

  useEffect(() => {
    if (!selectedId || detail?.session.id !== selectedId) return;

    for (const commit of checkpointCommits) {
      const requestKey = `${selectedId}:${commit}`;
      if (requestedChangesRef.current.has(requestKey)) continue;
      requestedChangesRef.current.add(requestKey);

      void api<{ changes: CodeChanges }>(
        `/api/sessions/${selectedId}/changes?commit=${encodeURIComponent(commit)}`,
      )
        .then((result) => {
          if (selectedSessionRef.current !== selectedId) return;
          setChangesByCommit((current) => ({ ...current, [commit]: result.changes }));
        })
        .catch((reason) => {
          if (selectedSessionRef.current !== selectedId) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    }
  }, [checkpointCommits, detail?.session.id, selectedId]);

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
  }, [changesByCommit, detail, liveToolOutput, selectedId, streamingText]);

  const sessionsByRepository = useMemo(() => {
    const groups = new Map<string, { repository: Repository; sessions: SessionListItem[] }>();
    for (const repository of repositories) groups.set(repository.id, { repository, sessions: [] });
    for (const item of sessions) {
      const group = groups.get(item.repository.id) ?? { repository: item.repository, sessions: [] };
      group.sessions.push(item);
      groups.set(item.repository.id, group);
    }
    return [...groups.values()];
  }, [repositories, sessions]);

  const activeRun = useMemo(() => detail?.runs.find((run) => activeStatuses.has(run.status)), [detail]);
  if (loading) return <div className="center-state">Opening Cloud Agents…</div>;

  if (repositories.length === 0) {
    return (
      <Onboarding
        error={error}
        onCreated={async (sessionId) => {
          await Promise.all([loadRepositories(), loadSessions()]);
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
            <small>Private repositories</small>
          </div>
        </div>

        <div className="session-list">
          <p className="eyebrow">Repositories</p>
          {sessionsByRepository.map((group) => (
            <div className="repository-group" key={group.repository.id}>
              <div className="repository-title">
                <strong>{group.repository.name}</strong>
                <button
                  title="New chat"
                  onClick={async () => {
                    const result = await api<{ session: { id: string } }>(
                      `/api/repositories/${group.repository.id}/chats`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          title: "New session",
                          baseBranch: group.repository.defaultBranch,
                        }),
                      },
                    );
                    await loadSessions();
                    setSelectedId(result.session.id);
                  }}
                >+</button>
              </div>
              {group.sessions.map((item) => (
                <button
                  className={`session-button ${item.session.id === selectedId ? "selected" : ""}`}
                  key={item.session.id}
                  onClick={() => setSelectedId(item.session.id)}
                >
                  <span>{item.session.title}</span>
                  <small>{item.session.branchName}</small>
                </button>
              ))}
            </div>
          ))}
        </div>

        {detail && (
          <button
            className="new-session"
            onClick={async () => {
              const result = await api<{ session: { id: string } }>(
                `/api/repositories/${detail.repository.id}/chats`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    title: "New session",
                    model: detail.session.defaultModel,
                    baseBranch: detail.repository.defaultBranch,
                  }),
                },
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
                <a href={detail.repository.repositoryUrl} target="_blank" rel="noreferrer">
                  {detail.repository.name} ↗
                </a>
                <code className="branch-label">{detail.session.branchName}</code>
                {detail.session.baseCommit && (
                  <span className="base-label">
                    Base {detail.session.baseBranch} · {detail.session.baseCommit.slice(0, 7)}
                  </span>
                )}
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
              {timeline.length === 0 && (
                <div className="empty-chat">
                  <div className="empty-icon">⌁</div>
                  <h2>What should the agent build?</h2>
                  <p>The agent can inspect files, edit code, run commands, and test its work.</p>
                </div>
              )}

              {timeline.map((item) =>
                item.kind === "message" ? (
                  <Message key={item.id} message={item.message} />
                ) : (
                  <Fragment key={item.id}>
                    <TimelineEvent
                      event={item.event}
                      reasoningCompleted={item.reasoningCompleted}
                      liveOutput={liveToolOutput[String(item.event.payload.callId ?? "")]}
                    />
                    {item.changeCommit && changesByCommit[item.changeCommit] && (
                      <CodeChangesCard
                        changes={changesByCommit[item.changeCommit]}
                        sessionId={detail.session.id}
                        commit={item.changeCommit}
                      />
                    )}
                  </Fragment>
                ),
              )}

              {detail.approvals.map((approval) => (
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
          <div className="center-state">Start a chat from a repository in the sidebar.</div>
        )}
      </main>
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
      <details className={`tool-message ${block?.data.isError ? "failed" : ""}`}>
        <summary>
          <span className="tool-icon">›</span>
          <span>{toolLabel(block?.data.toolName)}</span>
          <small>{block?.data.isError ? "Failed" : "Completed"}</small>
        </summary>
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

function TimelineEvent({
  event,
  reasoningCompleted,
  liveOutput,
}: {
  event: SessionEvent;
  reasoningCompleted: boolean;
  liveOutput?: string;
}) {
  let icon = "✓";
  let title = event.type.replaceAll("_", " ");
  let detail = "";
  let tone = "neutral";

  if (event.type === "run_started") {
    icon = "●";
    title = "Agent started working";
    detail = String(event.payload.model ?? "");
    tone = "working";
  } else if (event.type === "run_completed") {
    title = "Run completed";
    detail = `${Number(event.payload.outputTokens ?? 0).toLocaleString()} output tokens`;
    tone = "success";
  } else if (event.type === "run_failed") {
    icon = "!";
    title = "Run failed";
    detail = String(event.payload.error ?? "The agent could not complete this run.");
    tone = "error";
  } else if (event.type === "reasoning_started") {
    icon = reasoningCompleted ? "✓" : "●";
    title = reasoningCompleted ? "Reasoning completed" : "Agent is reasoning";
    tone = reasoningCompleted ? "neutral" : "working";
  } else if (event.type === "tool_started") {
    icon = "›";
    title = `${toolLabel(event.payload.toolName)} running`;
    tone = "working";
  } else if (event.type === "file_changed") {
    icon = "+";
    title = "File updated";
    detail = String(event.payload.path ?? "");
  } else if (event.type === "checkpoint_saved") {
    icon = "◆";
    title = "Checkpoint saved";
    const changedFileCount = Number(
      event.payload.changedFileCount ??
      (Array.isArray(event.payload.changedFiles) ? event.payload.changedFiles.length : 0),
    );
    detail = changedFileCount === 1 ? "1 changed file" : `${changedFileCount} changed files`;
  } else if (event.type === "approval_requested") {
    icon = "?";
    title = "Waiting for approval";
    detail = String(event.payload.reason ?? "");
    tone = "warning";
  } else if (event.type === "approval_resolved") {
    title = event.payload.approved ? "Approval granted" : "Approval denied";
    tone = event.payload.approved ? "success" : "error";
  }

  if (event.type === "tool_started" && liveOutput) {
    return (
      <details className="tool-message live-tool-output" open>
        <summary>
          <span className="tool-icon">›</span>
          <span>{toolLabel(event.payload.toolName)}</span>
          <small>Running live</small>
        </summary>
        <pre>{liveOutput}</pre>
      </details>
    );
  }

  return (
    <div className={`timeline-event ${tone}`}>
      <span className="timeline-event-icon">{icon}</span>
      <span className="timeline-event-copy">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </div>
  );
}

type DiffLine = {
  kind: "added" | "deleted" | "context" | "hunk" | "meta";
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
};

function diffLines(patch: string): DiffLine[] {
  const output: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let insideHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldNumber = Number(match[1]);
        newNumber = Number(match[2]);
      }
      insideHunk = true;
      output.push({ kind: "hunk", content: line, oldNumber: null, newNumber: null });
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push({ kind: "added", content: line.slice(1), oldNumber: null, newNumber: newNumber++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      output.push({ kind: "deleted", content: line.slice(1), oldNumber: oldNumber++, newNumber: null });
    } else if (line.startsWith(" ")) {
      output.push({ kind: "context", content: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    } else if (line.startsWith("\\")) {
      output.push({ kind: "meta", content: line, oldNumber: null, newNumber: null });
    }
  }
  return output;
}

function statusLabel(file: FileChange): string {
  if (file.status === "type_changed") return "Type changed";
  return `${file.status.charAt(0).toUpperCase()}${file.status.slice(1)}`;
}

function CodeChangesCard({ changes, sessionId, commit }: { changes: CodeChanges; sessionId: string; commit: string }) {
  return (
    <section className="code-changes">
      <header className="changes-header">
        <span className="changes-icon">±</span>
        <span>
          <strong>Code changes</strong>
          <small>{changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed</small>
        </span>
        <span className="change-totals"><b>+{changes.additions}</b><i>−{changes.deletions}</i></span>
        <a href={`/api/sessions/${sessionId}/changes.patch?commit=${encodeURIComponent(commit)}`} download>Download patch</a>
      </header>

      <div className="changed-files">
        {changes.files.map((file) => {
          const lines = diffLines(file.patch);
          return (
            <details className="changed-file" key={`${file.statusCode}-${file.path}`}>
              <summary>
                <span className={`change-status ${file.status}`} title={statusLabel(file)}>{file.statusCode.charAt(0)}</span>
                <span className="change-path">
                  <strong>{file.path}</strong>
                  {file.previousPath && <small>from {file.previousPath}</small>}
                </span>
                <span className="file-totals"><b>+{file.additions}</b><i>−{file.deletions}</i></span>
                <span className="chevron">⌄</span>
              </summary>
              <div className="diff-view">
                {file.binary ? (
                  <p className="binary-change">Binary file changed.</p>
                ) : lines.length > 0 ? (
                  lines.map((line, index) => (
                    <div className={`diff-line ${line.kind}`} key={`${index}-${line.kind}`}>
                      <span>{line.oldNumber ?? ""}</span>
                      <span>{line.newNumber ?? ""}</span>
                      <code>{line.kind === "added" ? "+" : line.kind === "deleted" ? "−" : " "}{line.content}</code>
                    </div>
                  ))
                ) : (
                  <p className="binary-change">No text lines changed.</p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: (approved: boolean) => Promise<void> }) {
  return (
    <div className="approval-card inline-approval">
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
      const repositoryResult = await api<{ repository: { id: string } }>("/api/repositories", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          repositoryUrl: data.get("repositoryUrl"),
          defaultBranch: data.get("baseBranch"),
        }),
      });
      const sessionResult = await api<{ session: { id: string } }>(
        `/api/repositories/${repositoryResult.repository.id}/chats`,
        {
          method: "POST",
          body: JSON.stringify({ title: "First session", model: data.get("model"), baseBranch: data.get("baseBranch") }),
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
        <button type="submit" disabled={busy}>{busy ? "Preparing repository…" : "Connect repository"}</button>
        <small>V0 supports public GitHub repositories.</small>
        {(localError ?? error) && <div className="form-error">{localError ?? error}</div>}
      </form>
    </main>
  );
}
