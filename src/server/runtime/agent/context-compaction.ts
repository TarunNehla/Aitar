import {
  calculateContextTokens,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummaryWithUsage,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Models, SimpleStreamOptions, Tool, Usage } from "@earendil-works/pi-ai";
import { errorForLog, logger } from "../../logger.js";

/** Bump whenever the summary instructions change, so old snapshots stay identifiable. */
export const COMPACTION_PROMPT_VERSION = "codex-summary-1";

/** Token budget for the recent user requests kept verbatim, when the caller configures none. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Room the summarizer is allowed for its prompt and its answer. */
export const SUMMARY_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/** Transient summarization failures are retried this many times before compaction gives up. */
export const SUMMARY_RETRIES = 2;

export type CompactionReason = "threshold" | "hard_token_limit" | "context_overflow";

/**
 * Added to Pi's summarization prompt, which already covers goal, constraints, progress,
 * decisions, next steps, and critical context.
 */
export const COMPACTION_INSTRUCTIONS = [
  "Another agent continues this task from your summary alone, without the older messages.",
  "After the sections above, always append these sections:",
  "## Files",
  "- Read: [paths read but not changed, or (none)]",
  "- Modified: [paths created or edited, or (none)]",
  "## Commands & Tests",
  "- [command or test that was run] -> [outcome, exit status, failing test names]",
  "## Repository State",
  "- [base branch, checkpoint or commit state, pull request, work not yet committed]",
  "Record every error or blocker under Progress -> Blocked with its exact message.",
  "Never include secrets, credentials, tokens, whole files, or long command output.",
  "Name a file by its path instead of quoting its contents.",
].join("\n");

export interface CompactionSnapshot {
  id: string;
  summary: string;
  /** Newest transcript message this snapshot covers. Anything after it is still verbatim history. */
  throughMessageId: string;
  /** Oldest user request kept verbatim. Everything between it and the horizon is summary-only. */
  firstPreservedMessageId: string;
}

export interface SnapshotRecord {
  summary: string;
  previousSnapshotId: string | null;
  throughMessageId: string;
  firstPreservedMessageId: string;
  model: string;
  reason: CompactionReason;
  promptVersion: string;
  tokensBefore: number;
  tokensAfter: number;
  usage: Usage;
}

export interface SummaryOutput {
  text: string;
  usage: Usage;
}

export type SummariseFn = (input: {
  messages: AgentMessage[];
  previousSummary?: string;
  signal?: AbortSignal;
}) => Promise<SummaryOutput>;

export interface ContextCompactorOptions {
  model: string;
  contextWindow: number;
  thresholdPercent: number;
  hardTokenLimit?: number;
  systemPrompt: () => string;
  tools: () => Tool[];
  /** Repository and workspace facts, read fresh at compaction time rather than carried in the summary. */
  environment: () => Promise<string> | string;
  summarise: SummariseFn;
  saveSnapshot: (record: SnapshotRecord) => Promise<{ id: string }>;
  emit: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
  onUsage?: (usage: Usage) => void;
  snapshot?: CompactionSnapshot;
  keepRecentTokens?: number;
  now?: () => number;
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[\s_-]?length[\s_-]?exceeded/i,
  /maximum context length/i,
  /exceeds? the (?:model'?s )?(?:maximum |max )?context/i,
  /context window (?:of )?\d/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  /prompt is too long/i,
  /too many (?:input )?tokens/i,
  /request too large/i,
];

/** True when the provider rejected the request because the prompt did not fit the model. */
export function isContextOverflowError(message: unknown): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

export function compactionLimit(input: {
  contextWindow: number;
  thresholdPercent: number;
  hardTokenLimit?: number;
}): number {
  const percentageLimit = Math.floor(input.contextWindow * (input.thresholdPercent / 100));
  return input.hardTokenLimit !== undefined ? Math.min(percentageLimit, input.hardTokenLimit) : percentageLimit;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** System instructions and tool definitions travel with every request, so they count towards the limit. */
export function overheadTokens(systemPrompt: string, tools: Tool[]): number {
  let chars = systemPrompt.length;
  for (const tool of tools) {
    chars += tool.name.length + tool.description.length + safeJsonLength(tool.parameters);
  }
  return Math.ceil(chars / 4);
}

/**
 * Provider usage already accounts for the system prompt, tool definitions and attachments,
 * so it is preferred when it describes the context being measured. Otherwise every part is estimated.
 */
export function estimateActiveContextTokens(input: {
  messages: AgentMessage[];
  overhead: number;
  reportsCurrentContext?: (message: AgentMessage) => boolean;
}): number {
  const reportsCurrentContext = input.reportsCurrentContext ?? (() => false);
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index];
    if (message.role !== "assistant" || !reportsCurrentContext(message)) continue;
    const reported = calculateContextTokens((message as AssistantMessage).usage);
    if (reported <= 0) continue;
    let tokens = reported;
    for (let next = index + 1; next < input.messages.length; next++) {
      tokens += estimateTokens(input.messages[next]);
    }
    return tokens;
  }
  return input.messages.reduce((total, message) => total + estimateTokens(message), input.overhead);
}

export interface CompactionPlan {
  summarise: AgentMessage[];
  preserved: AgentMessage[];
  throughMessageId: string;
  firstPreservedMessageId: string;
}

/**
 * The recent section holds real user requests only, taken newest first until the budget is spent.
 * The newest request is always kept, however large it is, because it is what the agent is working on.
 */
export function selectRecentUserMessages(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
  const preserved: AgentMessage[] = [];
  let total = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const tokens = estimateTokens(message);
    if (preserved.length > 0 && total + tokens > keepRecentTokens) break;
    preserved.push(message);
    total += tokens;
    if (total >= keepRecentTokens) break;
  }

  return preserved.reverse();
}

/**
 * Split the context into the part that becomes a summary and the recent user requests kept verbatim.
 * Returns null when there is nothing left to fold away.
 */
export function planCompaction(input: {
  messages: AgentMessage[];
  idFor: (message: AgentMessage) => string | undefined;
  keepRecentTokens?: number;
}): CompactionPlan | null {
  const { messages, idFor } = input;
  const keepRecentTokens = input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;

  // The summary and environment blocks are regenerated on every compaction, so they are never summarized.
  const start = messages.findIndex((message) => idFor(message) !== undefined);
  if (start < 0) return null;
  const range = messages.slice(start);

  // Only a stored message can be a boundary, because a snapshot has to name it.
  const eligible = range.filter((message) => message.role !== "user" || idFor(message) !== undefined);
  const preserved = selectRecentUserMessages(eligible, keepRecentTokens);
  if (preserved.length === 0) return null;

  const kept = new Set(preserved);
  const summarise = range.filter((message) => !kept.has(message));
  if (summarise.length === 0) return null;

  const firstPreservedMessageId = idFor(preserved[0]);
  let throughMessageId: string | undefined;
  for (const message of range) throughMessageId = idFor(message) ?? throughMessageId;
  if (!firstPreservedMessageId || !throughMessageId) return null;

  return { summarise, preserved, throughMessageId, firstPreservedMessageId };
}

/**
 * Keeps the model-visible context inside the compaction limit while the full transcript,
 * which stays in Postgres and in the agent's own message list, is never rewritten.
 */
export class ContextCompactor {
  private readonly log = logger.child({ component: "context-compaction" });
  private readonly messageIds = new Map<AgentMessage, string>();
  /** Assistant messages whose reported usage describes the context in use right now. */
  private readonly currentUsage = new Set<AgentMessage>();
  private readonly now: () => number;
  private snapshot?: CompactionSnapshot;
  private environmentMessage?: AgentMessage;
  private forced: CompactionReason | null = null;

  constructor(private readonly options: ContextCompactorOptions) {
    this.snapshot = options.snapshot;
    this.now = options.now ?? (() => Date.now());
  }

  get limit(): number {
    return compactionLimit({
      contextWindow: this.options.contextWindow,
      thresholdPercent: this.options.thresholdPercent,
      hardTokenLimit: this.options.hardTokenLimit,
    });
  }

  get activeSnapshot(): CompactionSnapshot | undefined {
    return this.snapshot;
  }

  /** Ties an agent message to its Postgres row, which is how a compaction records its boundaries. */
  register(message: AgentMessage, messageId: string): void {
    this.messageIds.set(message, messageId);
  }

  /** Provider usage is only trusted until the next compaction reshapes the context. */
  recordUsage(message: AgentMessage): void {
    if (message.role === "assistant") this.currentUsage.add(message);
  }

  /** Forces the next context build to compact, whatever the estimate says. */
  requestCompaction(reason: CompactionReason): void {
    this.forced = reason;
  }

  async transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    let active = messages;
    try {
      active = await this.activeContext(messages);
      const tokens = this.estimate(active);
      const limit = this.limit;
      const forced = this.forced;
      this.forced = null;
      if (!forced && tokens < limit) return active;

      const reason: CompactionReason = forced ?? this.reasonFor(tokens);
      const compacted = await this.compact({ active, tokensBefore: tokens, reason, signal });
      return compacted ?? active;
    } catch (error) {
      // transformContext must never reject: an unusable context is worse than an oversized one.
      this.log.error({ error: errorForLog(error) }, "Context compaction check failed");
      return active;
    }
  }

  private reasonFor(tokens: number): CompactionReason {
    const hardLimit = this.options.hardTokenLimit;
    return hardLimit !== undefined && tokens >= hardLimit ? "hard_token_limit" : "threshold";
  }

  private overhead(): number {
    return overheadTokens(this.options.systemPrompt(), this.options.tools());
  }

  private estimate(messages: AgentMessage[]): number {
    return estimateActiveContextTokens({
      messages,
      overhead: this.overhead(),
      reportsCurrentContext: (message) => this.currentUsage.has(message),
    });
  }

  /**
   * The smaller context the model actually sees: fresh environment, summary, the user requests
   * this snapshot preserved, then everything the transcript gained after the snapshot.
   */
  private async activeContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const snapshot = this.snapshot;
    if (!snapshot) return messages;

    const indexOf = (messageId: string) => messages.findIndex((message) => this.messageIds.get(message) === messageId);
    const firstPreserved = indexOf(snapshot.firstPreservedMessageId);
    const through = indexOf(snapshot.throughMessageId);
    if (firstPreserved < 0 || through < firstPreserved) {
      this.log.warn(
        { snapshotId: snapshot.id },
        "Snapshot boundaries are missing from the transcript; sending the full history",
      );
      return messages;
    }

    if (!this.environmentMessage) this.environmentMessage = await this.buildEnvironment();
    return [
      this.environmentMessage,
      createCompactionSummaryMessage(snapshot.summary, 0, new Date(this.now()).toISOString()),
      ...messages.slice(firstPreserved, through + 1).filter((message) => message.role === "user"),
      ...messages.slice(through + 1),
    ];
  }

  private async buildEnvironment(): Promise<AgentMessage> {
    let text = "";
    try {
      text = await this.options.environment();
    } catch (error) {
      this.log.warn({ error: errorForLog(error) }, "Environment information could not be refreshed");
    }
    return {
      role: "user",
      content: `<environment>\n${text}\n</environment>`,
      timestamp: this.now(),
    };
  }

  private async compact(input: {
    active: AgentMessage[];
    tokensBefore: number;
    reason: CompactionReason;
    signal?: AbortSignal;
  }): Promise<AgentMessage[] | null> {
    const plan = planCompaction({
      messages: input.active,
      idFor: (message) => this.messageIds.get(message),
      keepRecentTokens: this.options.keepRecentTokens,
    });
    if (!plan) {
      this.log.warn({ tokens: input.tokensBefore, limit: this.limit }, "No safe compaction cut point in the context");
      return null;
    }

    await this.options.emit("compaction_started", {
      reason: input.reason,
      model: this.options.model,
      tokensBefore: input.tokensBefore,
      limit: this.limit,
      contextWindow: this.options.contextWindow,
      summarisedMessages: plan.summarise.length,
      preservedMessages: plan.preserved.length,
    });

    let summary: SummaryOutput;
    try {
      summary = await this.options.summarise({
        messages: plan.summarise,
        previousSummary: this.snapshot?.summary,
        signal: input.signal,
      });
      this.options.onUsage?.(summary.usage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn({ error: errorForLog(error), reason: input.reason }, "Context compaction failed");
      await this.options.emit("compaction_failed", { reason: input.reason, error: message });
      return null;
    }

    const environment = await this.buildEnvironment();
    const compacted: AgentMessage[] = [
      environment,
      createCompactionSummaryMessage(summary.text, input.tokensBefore, new Date(this.now()).toISOString()),
      ...plan.preserved,
    ];
    const tokensAfter = estimateActiveContextTokens({ messages: compacted, overhead: this.overhead() });

    let snapshotId: string;
    try {
      const saved = await this.options.saveSnapshot({
        summary: summary.text,
        previousSnapshotId: this.snapshot?.id ?? null,
        throughMessageId: plan.throughMessageId,
        firstPreservedMessageId: plan.firstPreservedMessageId,
        model: this.options.model,
        reason: input.reason,
        promptVersion: COMPACTION_PROMPT_VERSION,
        tokensBefore: input.tokensBefore,
        tokensAfter,
        usage: summary.usage,
      });
      snapshotId = saved.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorForLog(error) }, "Context snapshot could not be stored");
      await this.options.emit("compaction_failed", { reason: input.reason, error: message });
      return null;
    }

    this.snapshot = {
      id: snapshotId,
      summary: summary.text,
      throughMessageId: plan.throughMessageId,
      firstPreservedMessageId: plan.firstPreservedMessageId,
    };
    this.environmentMessage = environment;
    this.currentUsage.clear();

    await this.options.emit("compaction_completed", {
      reason: input.reason,
      snapshotId,
      model: this.options.model,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      summarisedMessages: plan.summarise.length,
      preservedMessages: plan.preserved.length,
      inputTokens: summary.usage.input,
      outputTokens: summary.usage.output,
      costUsd: summary.usage.cost.total,
    });

    this.log.info(
      {
        reason: input.reason,
        snapshotId,
        tokensBefore: input.tokensBefore,
        tokensAfter,
        summarisedMessages: plan.summarise.length,
        preservedMessages: plan.preserved.length,
      },
      "Context compacted",
    );
    return compacted;
  }
}

/** Picks the newest snapshot whose boundaries both sit on the branch being replayed. */
export function snapshotForBranch(
  snapshots: Array<{
    id: string;
    summary: string;
    throughMessageId: string;
    firstPreservedMessageId: string;
    createdAt: Date;
  }>,
  branchMessageIds: Iterable<string>,
): CompactionSnapshot | undefined {
  const onBranch = new Set(branchMessageIds);
  const newestFirst = [...snapshots].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const match = newestFirst.find(
    (snapshot) => onBranch.has(snapshot.throughMessageId) && onBranch.has(snapshot.firstPreservedMessageId),
  );
  if (!match) return undefined;
  return {
    id: match.id,
    summary: match.summary,
    throughMessageId: match.throughMessageId,
    firstPreservedMessageId: match.firstPreservedMessageId,
  };
}

/**
 * Removes the failed assistant turn so the interrupted request can be retried, or returns
 * null when the failure was not an overflow or the transcript cannot be continued.
 */
export function prepareOverflowRetry(input: {
  errorMessage: string | undefined;
  messages: AgentMessage[];
}): AgentMessage[] | null {
  if (!isContextOverflowError(input.errorMessage)) return null;

  const last = input.messages[input.messages.length - 1];
  const failed = last?.role === "assistant" && (last as AssistantMessage).stopReason === "error";
  const messages = failed ? input.messages.slice(0, -1) : [...input.messages];
  const tail = messages[messages.length - 1];
  if (!tail || (tail.role !== "user" && tail.role !== "toolResult")) return null;
  return messages;
}

/**
 * generateSummaryWithUsage builds its own request options, so credentials and provider routing
 * ride on a wrapper that only has to satisfy the one call it makes.
 */
export function createSummariser(input: {
  models: Models;
  model: Model<any>;
  apiKey: () => string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
}): SummariseFn {
  const routed = {
    completeSimple: (model: Model<any>, context: Parameters<Models["completeSimple"]>[1], options?: SimpleStreamOptions) =>
      input.models.completeSimple(model, context, { ...options, apiKey: input.apiKey(), onPayload: input.onPayload }),
  } as unknown as Models;

  return async ({ messages, previousSummary, signal }) => {
    const result = await generateSummaryWithUsage(
      messages,
      routed,
      input.model,
      SUMMARY_RESERVE_TOKENS,
      signal,
      COMPACTION_INSTRUCTIONS,
      previousSummary,
      "off",
      { enabled: true, maxRetries: SUMMARY_RETRIES, baseDelayMs: 1_000 },
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
}
