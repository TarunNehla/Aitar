import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config } from "../config.js";
import {
  activateQueuedMessage,
  claimPendingRun,
  createAgentMessage,
  finishRun,
  finishToolExecution,
  getActiveBranchMessages,
  getSession,
  newWorkerId,
  recoverStaleRuns,
  renewRunLease,
  saveCheckpoint,
  startToolExecution,
  updateSessionEnvironment,
  updateSessionHead,
} from "../db/store.js";
import type { MessageView } from "../../shared/contracts.js";
import { withRepositoryGitAccess } from "../github/repository-access.js";
import { errorForLog, logger } from "../logger.js";
import { createAgentTools } from "./agent-tools.js";
import { EventWriter } from "./event-writer.js";
import { applyProviderRouting, configuredProviderPreferences } from "./openrouter-routing.js";
import { workspaceManager } from "./workspace-manager.js";
import { boundedTail, persistedToolSummary, safeToolArguments } from "./output-policy.js";

const models = createModels();
models.setProvider(openrouterProvider());

interface ClaimedRun {
  id: string;
  session_id: string;
  user_message_id: string;
  model: string;
  max_cost_usd: number;
  max_turns: number;
}

function modelFor(id: string): Model<any> {
  const exact = models.getModel("openrouter", id);
  if (exact) return exact;

  const fallback = models.getModel("openrouter", "openrouter/auto") ?? models.getModels("openrouter")[0];
  if (!fallback) throw new Error("Pi does not have an OpenRouter model catalog");
  return { ...fallback, id, name: id };
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function blockText(message: MessageView): string {
  return message.blocks
    .filter((block) => block.visibility === "model" || block.visibility === "both")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function toPiMessage(message: MessageView): AgentMessage | null {
  if (message.status === "queued") return null;
  const timestamp = new Date(message.createdAt).getTime();
  if (message.role === "user") {
    return { role: "user", content: blockText(message), timestamp };
  }

  if (message.role === "assistant") {
    const content: AssistantMessage["content"] = [];
    for (const block of message.blocks) {
      if (block.visibility !== "model" && block.visibility !== "both") continue;
      if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
      if (block.type === "reasoning_summary" && block.text) content.push({ type: "thinking", thinking: block.text });
      if (block.type === "tool_call") {
        content.push({
          type: "toolCall",
          id: String(block.data.callId ?? block.id),
          name: String(block.data.name ?? "unknown"),
          arguments: (block.data.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openrouter",
      model: message.model ?? config.OPENROUTER_MODEL,
      usage: zeroUsage(),
      stopReason: (message.blocks.some((block) => block.type === "tool_call") ? "toolUse" : "stop") as AssistantMessage["stopReason"],
      timestamp,
    };
  }

  if (message.role === "tool") {
    const block = message.blocks[0];
    return {
      role: "toolResult",
      toolCallId: String(block?.data.callId ?? message.id),
      toolName: String(block?.data.toolName ?? "unknown"),
      content: [{ type: "text", text: blockText(message) }],
      isError: Boolean(block?.data.isError),
      timestamp,
    };
  }

  return null;
}

function assistantBlocks(message: AssistantMessage): Array<{
  type: string;
  text?: string;
  data?: Record<string, unknown>;
  visibility: string;
}> {
  const blocks: Array<{ type: string; text?: string; data?: Record<string, unknown>; visibility: string }> = [];
  for (const block of message.content) {
    if (block.type === "text") blocks.push({ type: "text", text: block.text, visibility: "both" });
    if (block.type === "toolCall") {
      blocks.push({
        type: "tool_call",
        data: { callId: block.id, name: block.name, arguments: safeToolArguments(block.name, block.arguments) },
        visibility: "model",
      });
    }
  }
  return blocks;
}

function toolBlocks(message: ToolResultMessage, toolArguments?: Record<string, unknown>) {
  if (message.toolName === "finish") {
    const text = message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
    return [{
      type: "tool_result",
      text: boundedTail(text, 50_000).text,
      data: { callId: message.toolCallId, toolName: message.toolName, isError: message.isError },
      visibility: "both",
    }];
  }
  const summary = persistedToolSummary({
    toolName: message.toolName,
    isError: message.isError,
    details: message.details,
    arguments: toolArguments,
  });
  return [
    {
      type: "tool_result",
      text: summary.text,
      data: { callId: message.toolCallId, toolName: message.toolName, isError: message.isError, ...summary.data },
      visibility: "model",
    },
  ];
}

class ActiveRuns {
  private readonly agents = new Map<string, { agent: Agent; queuedMessageIds: string[] }>();

  set(runId: string, agent: Agent) {
    this.agents.set(runId, { agent, queuedMessageIds: [] });
  }

  delete(runId: string) {
    this.agents.delete(runId);
  }

  cancel(runId: string): boolean {
    const active = this.agents.get(runId);
    if (!active) return false;
    active.agent.abort();
    return true;
  }

  has(runId: string): boolean {
    return this.agents.has(runId);
  }

  steer(runId: string, messageId: string, text: string): boolean {
    const active = this.agents.get(runId);
    if (!active) return false;
    active.queuedMessageIds.push(messageId);
    active.agent.steer({ role: "user", content: text, timestamp: Date.now() });
    return true;
  }

  shiftQueuedMessage(runId: string): string | undefined {
    return this.agents.get(runId)?.queuedMessageIds.shift();
  }
}

export const activeRuns = new ActiveRuns();

export class AgentWorker {
  private readonly workerId = newWorkerId();
  private readonly log = logger.child({ component: "agent-worker", workerId: this.workerId });
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;

  async start(): Promise<void> {
    this.log.info("Agent worker recovery started");
    await recoverStaleRuns();
    this.log.info("Agent worker recovery completed");
    this.timer = setInterval(() => this.scheduleTick(), 500);
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.log.info({ activeRuns: this.active }, "Agent worker stopped");
  }

  private scheduleTick(): void {
    void this.tick().catch((error) => {
      this.log.error({ error: errorForLog(error) }, "Agent worker polling failed");
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || this.active >= config.MAX_ACTIVE_RUNS) return;
    this.ticking = true;
    try {
      const claimed = await claimPendingRun(this.workerId);
      if (!claimed) return;
      this.log.info({ runId: claimed.id, sessionId: claimed.session_id }, "Agent run claimed");
      this.active += 1;
      void this.execute(claimed)
        .catch((error) => {
          this.log.error(
            { error: errorForLog(error), runId: claimed.id, sessionId: claimed.session_id },
            "Agent run failed unexpectedly",
          );
        })
        .finally(() => {
          this.active -= 1;
          this.scheduleTick();
        });
    } finally {
      this.ticking = false;
    }
  }

  private async execute(run: ClaimedRun): Promise<void> {
    const startedAt = Date.now();
    const relation = await getSession(run.session_id);
    if (!relation) {
      await finishRun({ runId: run.id, status: "failed", error: "Session not found" });
      return;
    }

    const runLog = this.log.child({
      runId: run.id,
      sessionId: run.session_id,
      repositoryId: relation.repository.id,
      model: run.model,
    });
    runLog.info(
      {
        maxTurns: run.max_turns,
        maxCostUsd: run.max_cost_usd,
        providerRouting: configuredProviderPreferences(),
      },
      "Agent run started",
    );

    const writer = new EventWriter(run.session_id, run.id);
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let turns = 0;
    let parentMessageId = relation.session.currentLeafMessageId;
    const runBaseCommit = relation.session.headCommit;
    let repositoryPath = "";

    const checkpoint = async () => {
      if (!runBaseCommit || !repositoryPath) return null;
      const result = await workspaceManager.checkpoint({
        chatId: relation.session.id,
        repositoryId: relation.repository.id,
        repositoryPath,
        runId: run.id,
        baseCommit: runBaseCommit!,
      });
      if (!result.createdCommit) return null;
      await saveCheckpoint({
        sessionId: relation.session.id,
        runId: run.id,
        baseCommit: runBaseCommit,
        checkpointCommit: result.checkpointCommit,
        internalRef: result.internalRef,
      });
      await updateSessionHead(relation.session.id, result.checkpointCommit);
      await writer.emit("checkpoint_saved", {
        commit: result.checkpointCommit,
        createdCommit: true,
        changedFileCount: result.changedFiles.length,
      });
      return result;
    };

    try {
      if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
      if (!relation.session.baseCommit || !relation.session.headCommit) throw new Error("Chat environment is not ready");

      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: "starting" });
      const location = await withRepositoryGitAccess({ repository: relation.repository }, (gitEnvironment) =>
        workspaceManager.ensureChatCheckout({
          chatId: relation.session.id,
          repositoryId: relation.repository.id,
          repositoryUrl: relation.repository.repositoryUrl,
          baseBranch: relation.session.baseBranch,
          branchName: relation.session.branchName,
          headCommit: relation.session.headCommit as string,
          legacyWorkspaceId: typeof relation.session.settings.legacy_workspace_id === "string"
            ? relation.session.settings.legacy_workspace_id
            : undefined,
          gitEnvironment,
        }),
      );
      repositoryPath = location.repository;
      await workspaceManager.ensureSandbox(relation.session.id, repositoryPath);
      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: "ready" });
      await writer.emit("run_started", { model: run.model, workerId: this.workerId });

      const branch = await getActiveBranchMessages(run.session_id);
      const history = branch.map(toPiMessage).filter((message): message is AgentMessage => Boolean(message));
      const tools = createAgentTools({
        chatId: relation.session.id,
        repositoryPath,
        sessionId: run.session_id,
        runId: run.id,
        baseCommit: runBaseCommit!,
        writer,
      });

      const agent = new Agent({
        initialState: {
          systemPrompt: [
            "You are a coding agent working inside an isolated repository workspace.",
            "Inspect files before editing.",
            "Make focused changes that satisfy the user request.",
            "Run relevant tests before finishing.",
            "Use the finish tool only when the request is complete.",
          ].join("\n"),
          model: modelFor(run.model),
          thinkingLevel: "medium",
          tools,
          messages: history,
        },
        streamFn: models.streamSimple.bind(models),
        onPayload: applyProviderRouting,
        getApiKey: () => config.OPENROUTER_API_KEY,
        sessionId: run.session_id,
        toolExecution: "sequential",
      });

      activeRuns.set(run.id, agent);
      const toolArgumentsByCall = new Map<string, Record<string, unknown>>();
      agent.subscribe(async (event) => {
        await this.handleAgentEvent({
          event,
          run,
          writer,
          toolArgumentsByCall,
          getParent: () => parentMessageId,
          setParent: (id) => (parentMessageId = id),
        });

        if (event.type === "turn_start") {
          turns += 1;
          await renewRunLease(run.id, this.workerId);
          if (turns > run.max_turns) agent.abort();
        }

        if (event.type === "message_end" && event.message.role === "assistant") {
          inputTokens += event.message.usage.input;
          outputTokens += event.message.usage.output;
          costUsd += event.message.usage.cost.total;
          if (costUsd > run.max_cost_usd) agent.abort();
        }
      });

      await agent.continue();
      await writer.drain();
      if (agent.state.errorMessage && !agent.state.errorMessage.toLowerCase().includes("abort")) {
        throw new Error(agent.state.errorMessage);
      }
      await checkpoint();

      const status = agent.state.errorMessage?.toLowerCase().includes("abort") ? "cancelled" : "completed";
      await finishRun({ runId: run.id, status, inputTokens, outputTokens, costUsd });
      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: "ready" });
      await writer.emit("run_completed", { status, inputTokens, outputTokens, costUsd, turns });
      runLog.info(
        { status, inputTokens, outputTokens, costUsd, turns, durationMs: Date.now() - startedAt },
        "Agent run finished",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runLog.error(
        { error: errorForLog(error), inputTokens, outputTokens, costUsd, turns, durationMs: Date.now() - startedAt },
        "Agent run failed",
      );
      try {
        await checkpoint();
      } catch {
        // Preserve the original run error.
      }
      await finishRun({ runId: run.id, status: "failed", inputTokens, outputTokens, costUsd, error: message });
      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: repositoryPath ? "ready" : "failed" });
      await writer.emit("run_failed", { error: message });
    } finally {
      activeRuns.delete(run.id);
      await writer.drain();
    }
  }

  private async handleAgentEvent(input: {
    event: AgentEvent;
    run: ClaimedRun;
    writer: EventWriter;
    toolArgumentsByCall: Map<string, Record<string, unknown>>;
    getParent: () => string | null;
    setParent: (id: string) => void;
  }): Promise<void> {
    const { event, run, writer } = input;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") writer.delta("assistant_text_delta", "delta", update.delta);
      if (update.type === "thinking_start") await writer.emit("reasoning_started");
      if (update.type === "thinking_end") await writer.emit("reasoning_completed");
      return;
    }

    if (event.type === "message_start" && event.message.role === "user") {
      const queuedMessageId = activeRuns.shiftQueuedMessage(run.id);
      if (queuedMessageId) {
        const stored = await activateQueuedMessage({
          messageId: queuedMessageId,
          parentMessageId: input.getParent(),
        });
        input.setParent(stored.id);
        await writer.emit("user_message_accepted", { messageId: stored.id });
      }
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      await writer.drain();
      const stored = await createAgentMessage({
        sessionId: run.session_id,
        runId: run.id,
        parentMessageId: input.getParent(),
        role: "assistant",
        model: event.message.model,
        stopReason: event.message.stopReason,
        blocks: assistantBlocks(event.message),
      });
      input.setParent(stored.id);
      await writer.emit("assistant_message_completed", { messageId: stored.id, stopReason: event.message.stopReason });
      return;
    }

    if (event.type === "message_end" && event.message.role === "toolResult") {
      const toolArguments = input.toolArgumentsByCall.get(event.message.toolCallId);
      const stored = await createAgentMessage({
        sessionId: run.session_id,
        runId: run.id,
        parentMessageId: input.getParent(),
        role: "tool",
        blocks: toolBlocks(event.message, toolArguments),
      });
      input.toolArgumentsByCall.delete(event.message.toolCallId);
      input.setParent(stored.id);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.log.info(
        { runId: run.id, sessionId: run.session_id, toolCallId: event.toolCallId, toolName: event.toolName },
        "Agent tool started",
      );
      const durable = ["run_command", "write_file"].includes(event.toolName);
      const safeArguments = safeToolArguments(event.toolName, event.args);
      input.toolArgumentsByCall.set(event.toolCallId, safeArguments);
      if (durable) await startToolExecution({
        runId: run.id,
        callId: event.toolCallId,
        toolName: event.toolName,
        arguments: safeArguments,
      });
      const payload = {
        callId: event.toolCallId,
        toolName: event.toolName,
        arguments: safeArguments,
      };
      if (durable) await writer.emit("tool_started", payload);
      else writer.live("tool_started", payload);
      return;
    }

    if (event.type === "tool_execution_end") {
      const durable = ["run_command", "write_file"].includes(event.toolName);
      const summary = persistedToolSummary({
        toolName: event.toolName,
        isError: event.isError,
        details: event.result?.details,
        arguments: input.toolArgumentsByCall.get(event.toolCallId),
      });
      const toolLogData = {
        runId: run.id,
        sessionId: run.session_id,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
      if (event.isError) this.log.warn(toolLogData, "Agent tool failed");
      else this.log.info(toolLogData, "Agent tool completed");
      if (durable) await finishToolExecution({
        runId: run.id,
        callId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        result: { summary: summary.text, ...summary.data },
        exitCode: typeof summary.data.exitCode === "number" ? summary.data.exitCode : undefined,
      });
      const payload = {
        callId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        summary: summary.text,
      };
      if (durable) await writer.emit("tool_completed", payload);
      else writer.live("tool_completed", payload);
    }
  }
}

export const agentWorker = new AgentWorker();
