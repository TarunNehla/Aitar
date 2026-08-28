import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodeChanges, FileChange, MessageView, SessionEvent } from "../../shared/contracts";
import { api } from "../lib/api";
import {
  clearAuthQueryParameters,
  readAuthQueryParameters,
  returnToSignIn,
  useAuthMethods,
  useSession,
} from "../auth/auth-client";
import { readAuthEntry, signInEntry } from "../auth/auth-flow";
import { AuthScreen } from "../auth/components/AuthScreen";
import { Dialog } from "../components/Dialog";
import { Icon, type IconName } from "../components/Icon";
import { RepositoryConnect } from "../repository/components/RepositoryConnect";
import { Spinner } from "../components/Spinner";
import { UserMenu, type SessionUser } from "../auth/components/UserMenu";
import { defaultSessionTitle, deriveSessionTitle } from "./session-title";

interface Repository {
  id: string;
  name: string;
  repositoryUrl: string;
}

interface SessionListItem {
  session: {
    id: string;
    title: string;
    repositoryId: string;
    defaultModel: string;
    status: string;
    baseCommit: string | null;
    headCommit: string | null;
    envStatus: string;
    lastActiveAt?: string;
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

interface PullRequestSummary {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
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
  pullRequests: PullRequestSummary[];
}

/** Rendered from client state only, so it never reaches the database. */
interface PendingMessage {
  id: string;
  sessionId: string;
  text: string;
  messageId: string | null;
}

/**
 * A streamed assistant turn. It stays on screen after the run reports the message
 * as stored, because the stored copy only arrives with the next session fetch.
 */
interface StreamedAssistant {
  text: string;
  messageId: string | null;
}

const activeStatuses = new Set(["pending", "running", "cancelling"]);
const liveOutputLimit = 100_000;
const agentStatuses = [
  "Thinking…",
  "Reading the request…",
  "Inspecting the repository…",
  "Planning the next step…",
  "Noodling on it…",
];
const agentStatusInterval = 2_400;
const workspaceRoot = "/workspace";
const repositoryRootLabel = "repository";

/** Frontend-only until models are managed server side. */
const modelOptions = [{ value: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash" }];

/** Container paths are an implementation detail, so the thread shows repository-relative ones. */
function repositoryPath(value: string): string {
  const path = value.startsWith(`${workspaceRoot}/`) ? value.slice(workspaceRoot.length + 1) : value;
  return path === workspaceRoot || path === "" || path === "." ? repositoryRootLabel : path;
}

function relativeTime(value: string | undefined): string {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / (60 * 24));
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

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

function countLabel(value: unknown, singular: string, plural = `${singular}s`): string | null {
  const count = Number(value);
  if (!Number.isFinite(count)) return null;
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function joinDetail(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(" · ");
}

/** Why the agent had to shorten its own context, in the reader's terms rather than the runtime's. */
function compactionReason(value: unknown): string {
  if (value === "context_overflow") return "the model refused the request as too long";
  if (value === "hard_token_limit") return "the configured context budget was reached";
  return "the context window was nearly full";
}

function tokenTransfer(before: unknown, after: unknown): string {
  const from = Number(before);
  const to = Number(after);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  return `${from.toLocaleString()} → ${to.toLocaleString()} tokens`;
}

/** One borderless line per tool call: a verb, an optional mono chip, a muted detail. */
function toolPresentation(block: MessageView["blocks"][number] | undefined, failed: boolean) {
  const data = block?.data ?? {};
  const toolName = String(data.toolName ?? "tool");
  const status = failed ? "Failed" : "";
  const joined = (parts: Array<string | null>) => parts.filter(Boolean).join(" · ") || status;

  if (toolName === "read") {
    return {
      verb: "Read",
      code: repositoryPath(String(data.path ?? "file")),
      detail: joined([countLabel(data.lines, "line"), formatBytes(data.bytes)]),
    };
  }
  if (toolName === "edit") {
    return {
      verb: "Edited",
      code: repositoryPath(String(data.path ?? "file")),
      detail: joined([countLabel(data.edits, "edit")]),
    };
  }
  if (toolName === "write") {
    return {
      verb: "Wrote",
      code: repositoryPath(String(data.path ?? "file")),
      detail: joined([formatBytes(data.bytes)]),
    };
  }
  if (toolName === "grep") {
    return {
      verb: "Searched for",
      code: String(data.pattern ?? "pattern"),
      detail: joined([countLabel(data.matches, "match", "matches"), countLabel(data.files, "file")]),
    };
  }
  if (toolName === "find") {
    return {
      verb: "Found files",
      code: String(data.pattern ?? "pattern"),
      detail: joined([countLabel(data.results, "result")]),
    };
  }
  if (toolName === "ls") {
    return {
      verb: "Listed",
      code: repositoryPath(String(data.path ?? ".")),
      detail: joined([countLabel(data.entries, "entry", "entries")]),
    };
  }
  if (toolName === "bash") {
    const durationMs = Number(data.durationMs);
    return {
      verb: failed ? "Command failed" : "Ran",
      code: String(data.command ?? "command"),
      detail: joined([
        data.exitCode === null || data.exitCode === undefined ? null : `exit ${String(data.exitCode)}`,
        Number.isFinite(durationMs) ? `${(durationMs / 1_000).toFixed(1)}s` : null,
      ]),
    };
  }
  if (toolName === "start_process") {
    return { verb: "Started", code: String(data.name ?? "process"), detail: status };
  }
  if (toolName === "process_logs") {
    return {
      verb: "Read process logs",
      code: String(data.name ?? ""),
      detail: joined([
        formatBytes(data.stdoutBytes) ? `${formatBytes(data.stdoutBytes)} out` : null,
        Number(data.stderrBytes) > 0 ? `${formatBytes(data.stderrBytes)} err` : null,
      ]),
    };
  }
  if (toolName === "stop_process") {
    return { verb: "Stopped", code: String(data.name ?? "process"), detail: status };
  }
  if (toolName === "inspect_image") {
    return {
      verb: failed ? "Could not inspect screenshot" : "Inspected screenshot",
      code: "",
      detail: joined([visionDetail(data), formatBytes(data.bytes)]),
    };
  }
  if (toolName.startsWith("browser_")) {
    return browserPresentation(toolName, data, failed, joined, status);
  }
  return { verb: toolLabel(toolName), code: "", detail: status };
}

function visionDetail(data: Record<string, unknown>): string | null {
  if (data.routing !== "delegated") return null;
  const model = String(data.visionModel ?? "").trim();
  return model ? `Vision analysis completed · ${model}` : "Vision analysis completed";
}

function quoted(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text ? `“${text}”` : fallback;
}

function dimensions(data: Record<string, unknown>): string | null {
  const width = Number(data.width);
  const height = Number(data.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return `${width} × ${height}`;
}

/** Element labels are page content, so they stay in the verb; only URLs and keys earn a mono chip. */
function browserPresentation(
  toolName: string,
  data: Record<string, unknown>,
  failed: boolean,
  joined: (parts: Array<string | null>) => string,
  status: string,
) {
  const durationMs = Number(data.durationMs);
  const duration = Number.isFinite(durationMs) ? `${(durationMs / 1_000).toFixed(1)}s` : null;

  if (toolName === "browser_navigate") {
    return {
      verb: failed ? "Could not open" : "Opened",
      code: String(data.url ?? ""),
      detail: joined([
        String(data.title ?? "") || null,
        data.timedOut ? "timed out" : null,
        duration,
      ]),
    };
  }
  if (toolName === "browser_snapshot") {
    return { verb: "Read page structure", code: "", detail: joined([countLabel(data.elements, "element")]) };
  }
  if (toolName === "browser_click") {
    return {
      verb: `${failed ? "Could not click" : "Clicked"} ${quoted(data.label, "an element")}`,
      code: "",
      detail: joined([data.navigated ? "navigated" : null, duration]),
    };
  }
  if (toolName === "browser_type") {
    return {
      verb: `${failed ? "Could not type into" : "Typed into"} ${quoted(data.label, "a field")}`,
      code: "",
      detail: joined([countLabel(data.characters, "character"), duration]),
    };
  }
  if (toolName === "browser_select") {
    const values = Array.isArray(data.values) ? data.values : [];
    return {
      verb: `Selected ${values.length > 0 ? values.map((value) => quoted(value, "")).join(", ") : "an option"}`,
      code: "",
      detail: joined([duration]),
    };
  }
  if (toolName === "browser_press") {
    return { verb: "Pressed", code: String(data.key ?? "a key"), detail: joined([duration]) };
  }
  if (toolName === "browser_scroll") {
    return { verb: `Scrolled ${String(data.direction ?? "")}`.trim(), code: "", detail: status };
  }
  if (toolName === "browser_wait") {
    return { verb: "Waited for the page", code: "", detail: joined([duration]) };
  }
  if (toolName === "browser_screenshot") {
    return {
      verb: failed ? "Could not capture screenshot" : "Captured screenshot",
      code: "",
      detail: joined([dimensions(data), formatBytes(data.bytes), visionDetail(data)]),
    };
  }
  if (toolName === "browser_console") {
    const errors = Number(data.errors);
    const verb = Number.isFinite(errors) && errors > 0
      ? `Read ${errors} console ${errors === 1 ? "error" : "errors"}`
      : "Read console";
    return { verb, code: "", detail: joined([countLabel(data.messages, "message")]) };
  }
  if (toolName === "browser_close") {
    return { verb: "Closed browser", code: "", detail: status };
  }
  return { verb: toolLabel(toolName), code: "", detail: status };
}

const browserIcons: Record<string, IconName> = {
  browser_navigate: "globe",
  browser_snapshot: "layers",
  browser_click: "mouse-pointer-click",
  browser_type: "keyboard",
  browser_select: "keyboard",
  browser_press: "keyboard",
  browser_scroll: "layers",
  browser_wait: "clock",
  browser_screenshot: "camera",
  browser_console: "terminal",
  browser_close: "x",
  inspect_image: "search",
};

function toolIcon(toolName: string): IconName {
  return browserIcons[toolName] ?? "terminal";
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
// A checkpoint labels its diff card, a failure needs reading, and losing earlier
// context is something the reader has to be told about, so none of them collapse.
const uncollapsibleTypes = new Set([
  "checkpoint_saved",
  "run_failed",
  "compaction_completed",
  "compaction_failed",
]);

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
  const compactionOutcomes = events.filter(
    (event) => event.type === "compaction_completed" || event.type === "compaction_failed",
  );
  const visibleTypes = new Set([
    "run_started",
    "run_completed",
    "run_failed",
    "reasoning_started",
    "tool_started",
    "file_changed",
    "checkpoint_saved",
    "vision_capability_fallback",
    "compaction_started",
    "compaction_completed",
    "compaction_failed",
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
    // The in-flight line is there to explain the pause; its outcome replaces it.
    if (
      event.type === "compaction_started" &&
      compactionOutcomes.some(
        (outcome) => outcome.runId === event.runId && outcome.sequence > event.sequence,
      )
    ) {
      continue;
    }
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
  const { data: session, isPending } = useSession();
  const authMethods = useAuthMethods();
  const [authQuery] = useState(() => readAuthQueryParameters(window.location.search));
  const [entry, setEntry] = useState(() => readAuthEntry(window.location));

  useEffect(() => {
    clearAuthQueryParameters();
  }, []);

  if (entry.ownsPage) {
    return (
      <AuthScreen
        entry={entry}
        emailPassword={authMethods?.emailPassword ?? false}
        onLeaveLink={() => {
          returnToSignIn();
          setEntry(signInEntry);
        }}
      />
    );
  }

  if (isPending) return <div className="center-state">Opening Aitar…</div>;
  if (!session?.user) {
    if (!authMethods) return <div className="center-state">Opening Aitar…</div>;
    return <AuthScreen entry={entry} emailPassword={authMethods.emailPassword} />;
  }

  return (
    <Console
      key={session.user.id}
      user={session.user}
      installationError={authQuery.installationError}
      installationConnected={Boolean(authQuery.installationId)}
    />
  );
}

function Console({
  user,
  installationError,
  installationConnected,
}: {
  user: SessionUser;
  installationError: string | null;
  installationConnected: boolean;
}) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [changesByCommit, setChangesByCommit] = useState<Record<string, CodeChanges>>({});
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [streamedAssistants, setStreamedAssistants] = useState<StreamedAssistant[]>([]);
  const [liveToolOutput, setLiveToolOutput] = useState<Record<string, string>>({});
  const [processOutput, setProcessOutput] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [agentPlaceholder, setAgentPlaceholder] = useState<{ sessionId: string; afterSequence: number } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const titledSessionsRef = useRef(new Set<string>());
  const shouldFollowMessagesRef = useRef(true);
  const renderedSessionRef = useRef<string | null>(null);
  const requestedChangesRef = useRef(new Set<string>());
  const selectedSessionRef = useRef<string | null>(null);
  const eventReplayReadyRef = useRef(false);
  const latestSequenceRef = useRef(0);
  const detailRequestRef = useRef(0);
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
    // Several events refresh the session at once, so an earlier reply must never
    // replace a later one and drop the messages it already carried.
    const request = ++detailRequestRef.current;
    try {
      const result = await api<SessionDetail>(`/api/sessions/${sessionId}`);
      if (selectedSessionRef.current !== sessionId || request !== detailRequestRef.current) return;
      setDetail(result);
      setDetailError(null);
    } catch (reason) {
      if (selectedSessionRef.current !== sessionId || request !== detailRequestRef.current) return;
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
    setStreamedAssistants([]);
    setLiveToolOutput({});
    setProcessOutput({});
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
      if (event.transient && event.type === "process_output") {
        const processId = String(event.payload.processId ?? "");
        const chunk = String(event.payload.chunk ?? "");
        if (processId && chunk) {
          setProcessOutput((current) => {
            const combined = `${current[processId] ?? ""}${chunk}`;
            return { ...current, [processId]: combined.slice(-liveOutputLimit) };
          });
        }
        return;
      }
      if (event.transient && event.type === "process_exited") {
        void loadDetail(selectedId, true);
        return;
      }
      latestSequenceRef.current = Math.max(latestSequenceRef.current, event.sequence);
      setEvents((current) => {
        if (current.some((candidate) => candidate.id === event.id)) return current;
        return [...current, event].slice(-300);
      });

      if (eventReplayReadyRef.current && event.type === "assistant_text_delta") {
        const delta = String(event.payload.delta ?? "");
        if (delta) {
          setStreamedAssistants((current) => {
            const streaming = current[current.length - 1];
            if (!streaming || streaming.messageId !== null) {
              return [...current, { text: delta, messageId: null }];
            }
            return [...current.slice(0, -1), { ...streaming, text: streaming.text + delta }];
          });
        }
      }

      if (
        eventReplayReadyRef.current &&
        [
          "assistant_message_completed",
          "tool_completed",
          "run_completed",
          "run_failed",
        ].includes(event.type)
      ) {
        if (event.type === "assistant_message_completed") {
          const messageId = String(event.payload.messageId ?? "");
          setStreamedAssistants((current) => {
            const streaming = current[current.length - 1];
            if (!streaming || streaming.messageId !== null) return current;
            if (!messageId) return current.slice(0, -1);
            return [...current.slice(0, -1), { ...streaming, messageId }];
          });
        }
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

  // Client-side copies stay until the stored message they stand in for is fetched.
  useEffect(() => {
    const stored = (item: { messageId: string | null }) => Boolean(item.messageId && messageIds.has(item.messageId));
    const drop = <Item extends { messageId: string | null }>(current: Item[]) => {
      const next = current.filter((item) => !stored(item));
      return next.length === current.length ? current : next;
    };
    setPendingMessages(drop);
    setStreamedAssistants(drop);
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
  }, [
    agentStatus,
    changesByCommit,
    detail,
    liveToolOutput,
    processOutput,
    selectedId,
    streamedAssistants,
    visiblePending,
  ]);

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
  const pullRequestsByNumber = useMemo(
    () => Object.fromEntries((detail?.pullRequests ?? []).map((entry) => [entry.number, entry])),
    [detail?.pullRequests],
  );

  /** V0 titles come from the first user message, so no extra model call is needed. */
  const titleFromFirstMessage = useCallback((sessionId: string, text: string) => {
    if (titledSessionsRef.current.has(sessionId)) return;
    const title = deriveSessionTitle(text);
    if (title === defaultSessionTitle) return;

    titledSessionsRef.current.add(sessionId);
    setSessions((current) =>
      current.map((item) =>
        item.session.id === sessionId ? { ...item, session: { ...item.session, title } } : item,
      ),
    );
    setDetail((current) =>
      current?.session.id === sessionId ? { ...current, session: { ...current.session, title } } : current,
    );
    void api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title }) }).catch(() => {
      titledSessionsRef.current.delete(sessionId);
    });
  }, []);

  useEffect(() => {
    if (!detail || detail.session.title !== defaultSessionTitle) return;
    const first = detail.messages.find((message) => message.role === "user");
    if (first) titleFromFirstMessage(detail.session.id, messageText(first));
  }, [detail, titleFromFirstMessage]);

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

  const installationNotice = installationConnected ? "GitHub connected" : null;

  if (loading) return <div className="center-state">Opening Aitar…</div>;

  if (repositories.length === 0) {
    return (
      <RepositoryConnect
        variant="page"
        error={installationError ?? error}
        installationNotice={installationNotice}
        onCreated={openSession}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        {/* No brand mark exists for this product — the name is set in plain type. */}
        <div className="brand">
          <span className="brand-placeholder" />
          <strong>Aitar</strong>
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
                      { method: "POST", body: JSON.stringify({ title: defaultSessionTitle }) },
                    );
                    await loadSessions();
                    setSelectedId(result.session.id);
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
              {group.sessions.map((item) => {
                const activity = relativeTime(item.session.lastActiveAt);
                return (
                  <button
                    className={`session-button ${item.session.id === selectedId ? "selected" : ""}`}
                    key={item.session.id}
                    title={item.session.title}
                    aria-current={item.session.id === selectedId}
                    onClick={() => setSelectedId(item.session.id)}
                  >
                    <span className="session-name">{item.session.title}</span>
                    {activity && <small className="session-activity">{activity}</small>}
                  </button>
                );
              })}
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
                      title: defaultSessionTitle,
                      model: selectedItem.session.defaultModel,
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
          <UserMenu user={user} onSignedOut={clearAuthQueryParameters} />
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
                  <Message
                    key={node.item.id}
                    message={node.item.message}
                    sessionId={detail.session.id}
                    pullRequests={pullRequestsByNumber}
                    processOutput={processOutput}
                  />
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

              {streamedAssistants.map((item) => (
                <div
                  className={`message assistant-message ${item.messageId ? "" : "streaming"}`}
                  key={item.messageId ?? "streaming"}
                >
                  <div className="message-body markdown-content">
                    <MarkdownText>{item.text}</MarkdownText>
                    {!item.messageId && <span className="cursor" />}
                  </div>
                </div>
              ))}
              </div>
            </div>

            <Composer
              working={Boolean(activeRun)}
              model={detail.session.defaultModel}
              onCancel={activeRun ? () => api(`/api/runs/${activeRun.id}/cancel`, { method: "POST" }) : undefined}
              onSend={async (text) => {
                const sessionId = detail.session.id;
                const pendingId = crypto.randomUUID();
                setError(null);
                shouldFollowMessagesRef.current = true;
                if (detail.session.title === defaultSessionTitle) titleFromFirstMessage(sessionId, text);
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
        <RepositoryConnect
          variant="dialog"
          defaultModel={selectedItem?.session.defaultModel}
          error={installationError}
          installationNotice={installationNotice}
          onCreated={openSession}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}

/** The screenshot is the result, so it shows. A details wrapper would hide the only content. */
function ScreenshotThumbnail({
  sessionId,
  artifactId,
  url,
}: {
  sessionId: string;
  artifactId: string;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  const source = `/api/sessions/${sessionId}/artifacts/${artifactId}`;
  const description = url ? `Screenshot of ${url}` : "Screenshot of the page";

  return (
    <>
      <button className="screenshot-thumb" type="button" onClick={() => setOpen(true)}>
        <img src={source} alt={description} loading="lazy" />
      </button>
      {open && (
        <Dialog title={url || "Screenshot"} onClose={() => setOpen(false)}>
          <div className="screenshot-viewer">
            <img src={source} alt={description} />
          </div>
        </Dialog>
      )}
    </>
  );
}

function Message({
  message,
  sessionId,
  pullRequests,
  processOutput,
}: {
  message: MessageView;
  sessionId: string;
  pullRequests?: Record<number, PullRequestSummary>;
  processOutput?: Record<string, string>;
}) {
  if (message.role === "tool") {
    const block = message.blocks[0];
    const failed = Boolean(block?.data.isError);
    const toolName = String(block?.data.toolName ?? "tool");

    if (toolName === "create_pull_request" && !failed && block?.data.url) {
      const number = Number(block.data.number);
      const persisted = pullRequests?.[number];
      return (
        <PullRequestCard
          url={String(block.data.url)}
          number={number}
          title={persisted?.title ?? String(block.data.title ?? "")}
          state={persisted?.state ?? String(block.data.state ?? "open")}
          draft={persisted?.draft ?? Boolean(block.data.draft)}
        />
      );
    }

    const presentation = toolPresentation(block, failed);
    const line = (
      <>
        <span className="tool-icon">
          <Icon name={failed ? "alert-triangle" : toolIcon(toolName)} size={14} />
        </span>
        <span className="timeline-event-verb">{presentation.verb}</span>
        {presentation.code && (
          <span className="timeline-event-code" title={presentation.code}>{presentation.code}</span>
        )}
        {presentation.detail && <span className="timeline-event-detail tool-metadata">{presentation.detail}</span>}
      </>
    );

    // Only a live process has anything left to expand; every other summary is the whole result.
    const processId = toolName === "start_process" ? String(block?.data.processId ?? "") : "";
    const output = processId ? processOutput?.[processId] : undefined;
    if (output) {
      return (
        <details className="tool-message live-tool-output" open>
          <summary>
            <span className="chevron">
              <Icon name="chevron-right" size={14} />
            </span>
            {line}
          </summary>
          <pre>{output}</pre>
        </details>
      );
    }

    const showsArtifact = toolName === "browser_screenshot" || toolName === "inspect_image";
    const artifactId = showsArtifact ? String(block?.data.artifactId ?? "") : "";
    if (artifactId && !failed) {
      return (
        <div className="tool-screenshot">
          <div className="tool-result">{line}</div>
          <ScreenshotThumbnail
            sessionId={sessionId}
            artifactId={artifactId}
            url={String(block?.data.url ?? "")}
          />
        </div>
      );
    }

    return <div className={`tool-result ${failed ? "failed" : ""}`}>{line}</div>;
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

/** The hand-off out of the product, so it is the one bordered card a thread earns. */
function PullRequestCard({
  url,
  number,
  title,
  state,
  draft,
}: {
  url: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
}) {
  const tone = draft && state === "open" ? "draft" : state;
  const label = draft && state === "open" ? "Draft" : sentenceCase(state);

  return (
    <a className="pull-request-card" href={url} target="_blank" rel="noreferrer">
      <div className="pull-request-head">
        <span className={`pull-request-state ${tone}`}>
          <Icon name="git-pull-request" size={14} />
          {label}
        </span>
        <span className="pull-request-number">#{number}</span>
        <span className="spacer" />
        <span className="external">
          <Icon name="external-link" size={14} />
        </span>
      </div>
      {title && <div className="pull-request-title">{title}</div>}
    </a>
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

/** One option today, but a real select so the list can grow without a redesign. */
function ModelSelect({ model }: { model: string }) {
  const [selected, setSelected] = useState(model);
  const known = modelOptions.some((option) => option.value === selected);

  return (
    <div className="model-select">
      <select
        aria-label="Model"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
      >
        {!known && <option value={selected} disabled>{selected}</option>}
        {modelOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <Icon name="chevron-down" size={14} />
    </div>
  );
}

function Composer({
  working,
  model,
  onSend,
  onCancel,
}: {
  working: boolean;
  model: string;
  onSend: (text: string) => Promise<void>;
  onCancel?: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draft = text.trim();
  // One control: stop while a run is in flight, but typing turns it back into send so
  // guidance can still go out mid-run.
  const stopping = working && Boolean(onCancel) && !draft;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [text]);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={working ? "Send guidance while the agent works…" : "Describe the change you want…"}
          rows={1}
        />
        <div className="composer-actions">
          <ModelSelect model={model} key={model} />
          <button
            className="send-button"
            type={stopping ? "button" : "submit"}
            aria-label={stopping ? "Stop agent" : "Send message"}
            disabled={!stopping && (!draft || sending)}
            onClick={stopping ? () => void onCancel?.() : undefined}
          >
            <Icon name={stopping ? "square" : "arrow-up"} size={16} />
          </button>
        </div>
      </div>
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
    code = event.payload.path ? repositoryPath(String(event.payload.path)) : "";
  } else if (event.type === "checkpoint_saved") {
    icon = "layers";
    verb = "Saved checkpoint";
    const changedFileCount = Number(
      event.payload.changedFileCount ??
      (Array.isArray(event.payload.changedFiles) ? event.payload.changedFiles.length : 0),
    );
    detail = changedFileCount === 1 ? "1 changed file" : `${changedFileCount} changed files`;
  } else if (event.type === "compaction_started") {
    icon = "archive";
    verb = "Optimising context";
    const summarising = countLabel(event.payload.summarisedMessages, "earlier message");
    detail = joinDetail([compactionReason(event.payload.reason), summarising && `summarising ${summarising}`]);
    tone = "working";
  } else if (event.type === "compaction_completed") {
    icon = "archive";
    verb = "Context optimised";
    const summarised = countLabel(event.payload.summarisedMessages, "earlier message");
    const kept = countLabel(event.payload.preservedMessages, "recent request");
    detail = joinDetail([summarised && `${summarised} summarised`, kept && `${kept} kept in full`]);
    code = tokenTransfer(event.payload.tokensBefore, event.payload.tokensAfter);
    tone = "success";
  } else if (event.type === "compaction_failed") {
    icon = "alert-triangle";
    verb = "Context optimisation failed";
    detail = String(event.payload.error ?? "The earlier messages could not be summarised");
    tone = "warning";
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

  // Losing earlier context is a system action, not a step, so it gets a notice
  // treatment instead of blending into the quiet list of things the agent did.
  const notice = event.type.startsWith("compaction_") ? " notice" : "";

  return (
    <div className={`timeline-event ${tone}${notice}`}>
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
