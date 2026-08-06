import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodeChanges, FileChange, MessageView, SessionEvent } from "../shared/contracts";
import { api } from "./api";
import { Icon, type IconName } from "./components/Icon";
import { RepositorySetup } from "./components/RepositorySetup";
import { Spinner } from "./components/Spinner";

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

type EventItem = Extract<TimelineItem, { kind: "event" }>;

/** Each finished stretch of activity collapses behind a summary line. */
type ThreadNode =
  | { kind: "item"; item: TimelineItem }
  | { kind: "group"; id: string; label: string; items: EventItem[] };

interface SessionDetail extends SessionListItem {
  messages: MessageView[];
  runs: Run[];
  approvals: Approval[];
}

/** Rendered from client state only, so it never reaches the database. */
interface PendingMessage {
  id: string;
  sessionId: string;
  text: string;
  messageId: string | null;
}

const activeStatuses = new Set(["pending", "running", "waiting_for_approval", "cancelling"]);
const liveOutputLimit = 100_000;
const agentStatuses = [
  "Thinking…",
  "Reading the request…",
  "Inspecting the repository…",
  "Planning the next step…",
  "Noodling on it…",
];
const agentStatusInterval = 2_400;

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

function formatBytes(value: unknown): string | null {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function toolPresentation(block: MessageView["blocks"][number] | undefined, failed: boolean) {
  const data = block?.data ?? {};
  const toolName = String(data.toolName ?? "tool");
  const status = failed ? "Failed" : "Completed";

  if (toolName === "read_file") {
    const metadata = [
      Number.isFinite(Number(data.lines)) ? `${Number(data.lines).toLocaleString()} lines` : null,
      formatBytes(data.bytes),
    ].filter(Boolean).join(" · ");
    return { verb: "Read", code: String(data.path ?? "file"), detail: metadata || status };
  }
  if (toolName === "search_files") {
    const matches = Number(data.matches);
    return {
      verb: "Searched",
      code: String(data.query ?? "files"),
      detail: Number.isFinite(matches) ? `${matches.toLocaleString()} matches` : status,
    };
  }
  if (toolName === "list_files") {
    const count = Number(data.count);
    return {
      verb: "Listed files",
      code: "",
      detail: Number.isFinite(count) ? `${count.toLocaleString()} files` : status,
    };
  }
  if (toolName === "run_command") {
    const durationMs = Number(data.durationMs);
    const commandDetails = [
      data.exitCode === undefined ? null : `exit ${String(data.exitCode)}`,
      Number.isFinite(durationMs) ? `${(durationMs / 1_000).toFixed(1)}s` : null,
    ].filter(Boolean).join(" · ");
    return {
      verb: failed ? "Command failed" : "Ran",
      code: String(data.command ?? "command"),
      detail: commandDetails || status,
    };
  }
  if (toolName === "write_file") {
    return { verb: "Wrote", code: String(data.path ?? "file"), detail: status };
  }
  return { verb: toolLabel(toolName), code: "", detail: status };
}

function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const elapsed = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(1, Math.round(Math.max(0, elapsed) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

// Run lifecycle events describe the run itself, so they become the group summary
// rather than lines inside it.
const runLifecycleTypes = new Set(["run_started", "run_completed"]);
// A checkpoint labels its diff card and a failure needs reading, so neither collapses.
const uncollapsibleTypes = new Set(["checkpoint_saved", "run_failed"]);

/** Groups finished activity while keeping messages in their original timeline positions. */
function buildThread(timeline: TimelineItem[], events: SessionEvent[]): ThreadNode[] {
  const runs = new Map<string, { startedAt?: string; endedAt?: string; finished: boolean }>();
  for (const event of events) {
    if (!event.runId) continue;
    const run = runs.get(event.runId) ?? { finished: false };
    if (event.type === "run_started") run.startedAt = event.createdAt;
    if (event.type === "run_completed" || event.type === "run_failed") {
      run.endedAt = event.createdAt;
      run.finished = true;
    }
    runs.set(event.runId, run);
  }

  const nodes: ThreadNode[] = [];
  let pending: EventItem[] = [];
  let pendingRunId: string | null = null;

  function flush(boundaryAt?: string) {
    if (pending.length === 0) {
      pendingRunId = null;
      return;
    }
    const startedAt = pending[0].createdAt;
    const endedAt = boundaryAt ?? pending[pending.length - 1].createdAt;
    nodes.push({
      kind: "group",
      id: `group-${pending[0].id}`,
      label: `Worked for ${formatDuration(startedAt, endedAt)}`,
      items: pending,
    });
    pending = [];
    pendingRunId = null;
  }

  for (const item of timeline) {
    if (item.kind === "message") {
      flush(item.createdAt);
      nodes.push({ kind: "item", item });
      continue;
    }

    const finished = item.event.runId ? runs.get(item.event.runId)?.finished ?? false : false;
    if (!finished || uncollapsibleTypes.has(item.event.type)) {
      flush(item.createdAt);
      nodes.push({ kind: "item", item });
      continue;
    }
    if (runLifecycleTypes.has(item.event.type)) {
      if (item.event.type === "run_completed") flush(item.createdAt);
      continue;
    }

    if (pendingRunId && pendingRunId !== item.event.runId) flush(item.createdAt);
    pendingRunId = item.event.runId;
    pending.push(item);
  }
  flush();

  return nodes;
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

/** Placeholder copy for the gap between sending and the first backend event. */
function useRotatingStatus(active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % agentStatuses.length),
      agentStatusInterval,
    );
    return () => clearInterval(timer);
  }, [active]);

  return agentStatuses[index];
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
  const [detailError, setDetailError] = useState<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [agentPlaceholder, setAgentPlaceholder] = useState<{ sessionId: string; afterSequence: number } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldFollowMessagesRef = useRef(true);
  const renderedSessionRef = useRef<string | null>(null);
  const requestedChangesRef = useRef(new Set<string>());
  const selectedSessionRef = useRef<string | null>(null);
  const eventReplayReadyRef = useRef(false);
  const latestSequenceRef = useRef(0);
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

  const loadDetail = useCallback(async (sessionId: string, background = false) => {
    if (!background) setDetailError(null);
    try {
      const result = await api<SessionDetail>(`/api/sessions/${sessionId}`);
      if (selectedSessionRef.current !== sessionId) return;
      setDetail(result);
      setDetailError(null);
    } catch (reason) {
      if (selectedSessionRef.current !== sessionId) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      if (background) setError(message);
      else setDetailError(message);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadRepositories(), loadSessions()])
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [loadRepositories, loadSessions]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setPendingMessages([]);
    setAgentPlaceholder(null);
    setChangesByCommit({});
    requestedChangesRef.current.clear();
    if (!selectedId) return;

    setEvents([]);
    setStreamingText("");
    setLiveToolOutput({});
    eventReplayReadyRef.current = false;
    latestSequenceRef.current = 0;
    shouldFollowMessagesRef.current = true;
    renderedSessionRef.current = null;
    void loadDetail(selectedId);

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
      latestSequenceRef.current = Math.max(latestSequenceRef.current, event.sequence);
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
        void loadDetail(selectedId, true);
        void loadSessions();
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically using the last event ID.
    };
    return () => source.close();
  }, [selectedId, loadDetail, loadSessions]);

  const messageIds = useMemo(
    () => new Set((detail?.messages ?? []).map((message) => message.id)),
    [detail?.messages],
  );
  const visiblePending = useMemo(
    () => pendingMessages.filter(
      (item) => item.sessionId === selectedId && !(item.messageId && messageIds.has(item.messageId)),
    ),
    [pendingMessages, selectedId, messageIds],
  );

  useEffect(() => {
    setPendingMessages((current) => {
      const next = current.filter((item) => !(item.messageId && messageIds.has(item.messageId)));
      return next.length === current.length ? current : next;
    });
  }, [messageIds]);

  const awaitingAgent = Boolean(
    agentPlaceholder &&
    agentPlaceholder.sessionId === selectedId &&
    !events.some((event) => event.sequence > agentPlaceholder.afterSequence),
  );
  const agentStatus = useRotatingStatus(awaitingAgent);

  const timeline = useMemo(
    () => buildTimeline(detail?.messages ?? [], events),
    [detail?.messages, events],
  );
  const thread = useMemo(() => buildThread(timeline, events), [timeline, events]);
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
  }, [agentStatus, changesByCommit, detail, liveToolOutput, selectedId, streamingText, visiblePending]);

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

  const selectedItem = useMemo(
    () => sessions.find((item) => item.session.id === selectedId),
    [sessions, selectedId],
  );
  const activeRun = useMemo(() => detail?.runs.find((run) => activeStatuses.has(run.status)), [detail]);

  const openSession = useCallback(async (sessionId: string) => {
    await Promise.all([loadRepositories(), loadSessions()]);
    setSelectedId(sessionId);
    setSetupOpen(false);
  }, [loadRepositories, loadSessions]);

  const sessionView = !selectedId
    ? "empty"
    : detailError
      ? "error"
      : detail?.session.id === selectedId ? "ready" : "loading";

  if (loading) return <div className="center-state">Opening Cloud Agents…</div>;

  if (repositories.length === 0) {
    return <RepositorySetup variant="page" error={error} onCreated={openSession} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        {/* No brand mark exists for this product — the name is set in plain type. */}
        <div className="brand">
          <span className="brand-placeholder" />
          <strong>Cloud Agents</strong>
        </div>

        <div className="session-list ds-scroll">
          <p className="eyebrow">Repositories</p>
          {sessionsByRepository.map((group) => (
            <div className="repository-group" key={group.repository.id}>
              <div className="repository-title">
                <strong>{group.repository.name}</strong>
                <button
                  aria-label={`New session in ${group.repository.name}`}
                  title="New session"
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
                >
                  <Icon name="plus" size={14} />
                </button>
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

        <div className="sidebar-actions">
          {selectedItem && (
            <button
              className="new-session"
              onClick={async () => {
                const result = await api<{ session: { id: string } }>(
                  `/api/repositories/${selectedItem.repository.id}/chats`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      title: "New session",
                      model: selectedItem.session.defaultModel,
                      baseBranch: selectedItem.repository.defaultBranch,
                    }),
                  },
                );
                await loadSessions();
                setSelectedId(result.session.id);
              }}
            >
              <Icon name="plus" size={16} />
              New session
            </button>
          )}
          <button className="primary-button" onClick={() => setSetupOpen(true)}>
            <Icon name="folder-git-2" size={16} />
            New repository
          </button>
        </div>
      </aside>

      <main className="conversation">
        {sessionView === "loading" && (
          <div className="conversation-state">
            <Spinner size={20} label="Loading session…" />
          </div>
        )}

        {sessionView === "empty" && (
          <div className="conversation-state">
            <div className="empty-icon">
              <Icon name="message-square" size={20} />
            </div>
            <h2>No session open</h2>
            <p>Pick a session from the sidebar, or start a new one</p>
          </div>
        )}

        {sessionView === "error" && (
          <div className="conversation-state">
            <div className="empty-icon">
              <Icon name="alert-triangle" size={20} />
            </div>
            <h2>Session did not load</h2>
            <p>{detailError}</p>
            <button
              className="ghost-button"
              type="button"
              onClick={() => selectedId && void loadDetail(selectedId)}
            >
              <Icon name="rotate-ccw" size={16} />
              Retry
            </button>
          </div>
        )}

        {sessionView === "ready" && detail && (
          <>
            <header className="conversation-header">
              <div className="conversation-title">
                <h1>{detail.session.title}</h1>
                <a
                  className="repository-link"
                  href={detail.repository.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.repository.name}
                  <Icon name="external-link" size={14} />
                </a>
                <code className="branch-label">
                  <Icon name="git-branch" size={14} />
                  {detail.session.branchName}
                </code>
                {detail.session.baseCommit && (
                  <span className="base-label">
                    {detail.session.baseBranch} · {detail.session.baseCommit.slice(0, 7)}
                  </span>
                )}
                <span className="model-label">{detail.session.defaultModel}</span>
              </div>
              <div className={`run-state ${activeRun ? "working" : "ready"}`}>
                <span />
                <small>{activeRun ? sentenceCase(activeRun.status) : "Ready"}</small>
              </div>
            </header>

            <div
              className="messages ds-scroll"
              ref={messagesRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                shouldFollowMessagesRef.current = distanceFromBottom < 80;
              }}
            >
              <div className="thread">
              {timeline.length === 0 && visiblePending.length === 0 && (
                <div className="empty-chat">
                  <div className="empty-icon">
                    <Icon name="sparkles" size={20} />
                  </div>
                  <h2>What should the agent build?</h2>
                  <p>The agent can inspect files, edit code, run commands, and test its work.</p>
                </div>
              )}

              {thread.map((node) =>
                node.kind === "group" ? (
                  <StepGroup key={node.id} label={node.label}>
                    {node.items.map((item) => (
                      <TimelineEvent
                        key={item.id}
                        event={item.event}
                        reasoningCompleted={item.reasoningCompleted}
                      />
                    ))}
                  </StepGroup>
                ) : node.item.kind === "message" ? (
                  <Message key={node.item.id} message={node.item.message} />
                ) : (
                  <Fragment key={node.item.id}>
                    <TimelineEvent
                      event={node.item.event}
                      reasoningCompleted={node.item.reasoningCompleted}
                      liveOutput={liveToolOutput[String(node.item.event.payload.callId ?? "")]}
                    />
                    {node.item.changeCommit && changesByCommit[node.item.changeCommit] && (
                      <CodeChangesCard
                        changes={changesByCommit[node.item.changeCommit]}
                        sessionId={detail.session.id}
                        commit={node.item.changeCommit}
                      />
                    )}
                  </Fragment>
                ),
              )}

              {visiblePending.map((item) => (
                <div className="message user-message pending" key={item.id}>
                  <div className="message-body">{item.text}</div>
                  <span className="user-avatar">You</span>
                </div>
              ))}

              {awaitingAgent && (
                <div className="timeline-event working">
                  <span className="timeline-event-icon">
                    <Icon name="sparkles" size={14} />
                  </span>
                  <span className="timeline-event-verb">{agentStatus}</span>
                </div>
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
                    await loadDetail(detail.session.id, true);
                  }}
                />
              ))}

              {streamingText && (
                <div className="message assistant-message streaming">
                  <div className="message-body markdown-content">
                    <MarkdownText>{streamingText}</MarkdownText>
                    <span className="cursor" />
                  </div>
                </div>
              )}
              </div>
            </div>

            <Composer
              working={Boolean(activeRun)}
              onCancel={activeRun ? () => api(`/api/runs/${activeRun.id}/cancel`, { method: "POST" }) : undefined}
              onSend={async (text) => {
                const sessionId = detail.session.id;
                const pendingId = crypto.randomUUID();
                setError(null);
                shouldFollowMessagesRef.current = true;
                setPendingMessages((current) => [
                  ...current,
                  { id: pendingId, sessionId, text, messageId: null },
                ]);
                setAgentPlaceholder({ sessionId, afterSequence: latestSequenceRef.current });

                try {
                  const result = await api<{ message: { id: string } }>(
                    `/api/sessions/${sessionId}/messages`,
                    { method: "POST", body: JSON.stringify({ text }) },
                  );
                  setPendingMessages((current) =>
                    current.map((item) => item.id === pendingId ? { ...item, messageId: result.message.id } : item),
                  );
                  await loadDetail(sessionId, true);
                } catch (reason) {
                  setPendingMessages((current) => current.filter((item) => item.id !== pendingId));
                  setAgentPlaceholder((current) => current?.sessionId === sessionId ? null : current);
                  setError(reason instanceof Error ? reason.message : String(reason));
                  throw reason;
                }
              }}
            />
          </>
        )}

        {error && <div className="toast">{error}</div>}
      </main>

      {setupOpen && (
        <RepositorySetup
          variant="dialog"
          defaultModel={selectedItem?.session.defaultModel}
          onCreated={openSession}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}

function Message({ message }: { message: MessageView }) {
  if (message.role === "tool") {
    const block = message.blocks[0];
    if (block?.data.toolName === "finish") {
      return (
        <div className="message assistant-message">
          <div className="message-body markdown-content">
            <MarkdownText>{messageText(message)}</MarkdownText>
          </div>
        </div>
      );
    }
    const failed = Boolean(block?.data.isError);
    const presentation = toolPresentation(block, failed);
    const toolName = String(block?.data.toolName ?? "tool");
    const metadataClass = ["read_file", "run_command"].includes(toolName)
      ? "timeline-event-detail tool-metadata"
      : "timeline-event-detail";

    if (toolName === "read_file") {
      return (
        <div className={`tool-result ${failed ? "failed" : ""}`}>
          <span className="tool-icon">
            <Icon name={failed ? "alert-triangle" : "terminal"} size={14} />
          </span>
          <span className="timeline-event-verb">{presentation.verb}</span>
          {presentation.code && (
            <span className="timeline-event-code" title={presentation.code}>{presentation.code}</span>
          )}
          <span className={metadataClass}>{presentation.detail}</span>
        </div>
      );
    }

    const listedFiles = toolName === "list_files" && Array.isArray(block?.data.files)
      ? block.data.files.map(String)
      : [];
    return (
      <details className={`tool-message ${failed ? "failed" : ""}`}>
        <summary>
          <span className="chevron">
            <Icon name="chevron-right" size={14} />
          </span>
          <span className="tool-icon">
            <Icon name={failed ? "alert-triangle" : "terminal"} size={14} />
          </span>
          <span className="timeline-event-verb">{presentation.verb}</span>
          {presentation.code && (
            <span className="timeline-event-code" title={presentation.code}>{presentation.code}</span>
          )}
          <span className={metadataClass}>{presentation.detail}</span>
        </summary>
        <pre>{listedFiles.length > 0 ? listedFiles.join("\n") : messageText(message)}</pre>
      </details>
    );
  }

  if (message.role === "user") {
    return (
      <div className={`message user-message ${message.status === "queued" ? "queued" : ""}`}>
        <div className="message-body">{messageText(message)}</div>
        <span className="user-avatar">You</span>
      </div>
    );
  }

  return (
    <div className="message assistant-message">
      <div className="message-body markdown-content">
        <MarkdownText>{messageText(message)}</MarkdownText>
      </div>
    </div>
  );
}

/** Collapses a finished run's steps into one line — the user reads the prose, not the steps. */
function StepGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="step-group">
      <summary>
        <span className="chevron">
          <Icon name="chevron-right" size={14} />
        </span>
        <span className="timeline-event-verb">{label}</span>
      </summary>
      <div className="step-group-steps">{children}</div>
    </details>
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
    const draft = text.trim();
    if (!draft || sending) return;
    setSending(true);
    setText("");
    try {
      await onSend(draft);
    } catch {
      setText(draft);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-box">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={working ? "Send guidance while the agent works…" : "Describe the change you want…"}
          rows={2}
        />
        <div className="composer-actions">
          {onCancel && (
            <button className="cancel-button" type="button" onClick={() => void onCancel()}>
              <Icon name="square" size={14} />
              Stop
            </button>
          )}
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={!text.trim() || sending}
          >
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </div>
      <small className="composer-hint">Enter to send · Shift + Enter for a new line</small>
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
  // One line per action: a verb, a muted detail, an optional mono chip.
  let icon: IconName = "check";
  let verb = sentenceCase(event.type);
  let detail = "";
  let code = "";
  let tone = "neutral";

  if (event.type === "run_started") {
    icon = "play";
    verb = "Started working";
    tone = "working";
  } else if (event.type === "run_completed") {
    icon = "check";
    verb = "Finished";
    code = `${Number(event.payload.outputTokens ?? 0).toLocaleString()} tokens`;
    tone = "success";
  } else if (event.type === "run_failed") {
    icon = "alert-triangle";
    verb = "Run failed";
    detail = String(event.payload.error ?? "The agent could not complete this run");
    tone = "error";
  } else if (event.type === "reasoning_started") {
    icon = "sparkles";
    verb = reasoningCompleted ? "Finished reasoning" : "Reasoning";
    tone = reasoningCompleted ? "neutral" : "working";
  } else if (event.type === "tool_started") {
    icon = "terminal";
    verb = "Running";
    code = toolLabel(event.payload.toolName);
    tone = "working";
  } else if (event.type === "file_changed") {
    icon = "file-diff";
    verb = "Edited";
    code = String(event.payload.path ?? "");
  } else if (event.type === "checkpoint_saved") {
    icon = "layers";
    verb = "Saved checkpoint";
    const changedFileCount = Number(
      event.payload.changedFileCount ??
      (Array.isArray(event.payload.changedFiles) ? event.payload.changedFiles.length : 0),
    );
    detail = changedFileCount === 1 ? "1 changed file" : `${changedFileCount} changed files`;
  } else if (event.type === "approval_requested") {
    icon = "alert-triangle";
    verb = "Waiting for approval";
    detail = String(event.payload.reason ?? "");
    tone = "warning";
  } else if (event.type === "approval_resolved") {
    icon = event.payload.approved ? "check" : "x";
    verb = event.payload.approved ? "Approval granted" : "Approval denied";
    tone = event.payload.approved ? "success" : "error";
  }

  if (event.type === "tool_started" && liveOutput) {
    return (
      <details className="tool-message live-tool-output" open>
        <summary>
          <span className="chevron">
            <Icon name="chevron-right" size={14} />
          </span>
          <span className="tool-icon">
            <Icon name="terminal" size={14} />
          </span>
          <span className="timeline-event-verb">Running</span>
          <span className="timeline-event-code">{toolLabel(event.payload.toolName)}</span>
        </summary>
        <pre>{liveOutput}</pre>
      </details>
    );
  }

  return (
    <div className={`timeline-event ${tone}`}>
      <span className="timeline-event-icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="timeline-event-verb">{verb}</span>
      {detail && <span className="timeline-event-detail">{detail}</span>}
      {code && <span className="timeline-event-code">{code}</span>}
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
        <span className="changes-icon">
          <Icon name="file-diff" size={16} />
        </span>
        <strong>Code changes</strong>
        <small>{changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed</small>
        <span className="change-totals"><b>+{changes.additions}</b><i>−{changes.deletions}</i></span>
        <a
          className="download-patch"
          href={`/api/sessions/${sessionId}/changes.patch?commit=${encodeURIComponent(commit)}`}
          download
        >
          Download patch
        </a>
      </header>

      <div className="changed-files">
        {changes.files.map((file) => {
          const lines = diffLines(file.patch);
          return (
            <details className="changed-file" key={`${file.statusCode}-${file.path}`}>
              <summary>
                <span className="chevron">
                  <Icon name="chevron-right" size={14} />
                </span>
                <span className={`change-status ${file.status}`} title={statusLabel(file)}>{file.statusCode.charAt(0)}</span>
                <span className="change-path">
                  <strong>{file.path}</strong>
                  {file.previousPath && <small>from {file.previousPath}</small>}
                </span>
                <span className="file-totals"><b>+{file.additions}</b><i>−{file.deletions}</i></span>
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
    <div className="approval-card">
      <p className="eyebrow">Approval needed</p>
      <strong>{approval.reason}</strong>
      {approval.command && <code>{approval.command}</code>}
      <div className="approval-actions">
        <button onClick={() => void onResolve(false)}>Deny</button>
        <button className="approve" onClick={() => void onResolve(true)}>Allow once</button>
      </div>
    </div>
  );
}
