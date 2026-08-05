import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { stat } from "node:fs/promises";
import { config } from "../config.js";
import {
  appendEvent,
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
  saveArtifact,
  saveCheckpoint,
  startToolExecution,
} from "../db/store.js";
import type { MessageView } from "../../shared/contracts.js";
import { errorForLog, logger } from "../logger.js";
import { createAgentTools } from "./agent-tools.js";
import { EventWriter } from "./event-writer.js";
import { workspaceManager } from "./workspace-manager.js";

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

function assistantBlocks(message: AssistantMessage) {
  return message.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text, visibility: "both" };
    if (block.type === "thinking") {
      return {
        type: "reasoning_summary",
        text: block.thinking,
        data: { redacted: block.redacted ?? false, signature: block.thinkingSignature },
        visibility: "model",
      };
    }
    return {
      type: "tool_call",
      data: { callId: block.id, name: block.name, arguments: block.arguments },
      visibility: "model",
    };
  });
}

function toolBlocks(message: ToolResultMessage) {
  return [
    {
      type: "tool_result",
      text: message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n"),
      data: { callId: message.toolCallId, toolName: message.toolName, isError: message.isError },
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
      workspaceId: relation.workspace.id,
      model: run.model,
    });
    runLog.info({ maxTurns: run.max_turns, maxCostUsd: run.max_cost_usd }, "Agent run started");

    const writer = new EventWriter(run.session_id, run.id);
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let turns = 0;
    let parentMessageId = relation.session.currentLeafMessageId;
    let lastCheckpoint: Awaited<ReturnType<typeof workspaceManager.checkpoint>> | null = null;

    const checkpoint = async () => {
      if (!relation.workspace.baseCommit) return null;
      lastCheckpoint = await workspaceManager.checkpoint({
        workspaceId: relation.workspace.id,
        repositoryPath: relation.workspace.localPath,
        runId: run.id,
        baseCommit: relation.workspace.baseCommit,
      });
      await saveCheckpoint({
        workspaceId: relation.workspace.id,
        runId: run.id,
        baseCommit: relation.workspace.baseCommit,
        checkpointCommit: lastCheckpoint.checkpointCommit,
        internalRef: lastCheckpoint.internalRef,
      });
      await writer.emit("checkpoint_saved", {
        commit: lastCheckpoint.checkpointCommit,
        changedFiles: lastCheckpoint.changedFiles,
      });
      return lastCheckpoint;
    };

    try {
      if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
      if (!relation.workspace.baseCommit) throw new Error("Workspace is not ready");

      await workspaceManager.ensureSandbox(relation.workspace.id, relation.workspace.localPath);
      await writer.emit("run_started", { model: run.model, workerId: this.workerId });

      const branch = await getActiveBranchMessages(run.session_id);
      const history = branch.map(toPiMessage).filter((message): message is AgentMessage => Boolean(message));
      const tools = createAgentTools({
        workspaceId: relation.workspace.id,
        repositoryPath: relation.workspace.localPath,
        sessionId: run.session_id,
        runId: run.id,
        baseCommit: relation.workspace.baseCommit,
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
        getApiKey: () => config.OPENROUTER_API_KEY,
        sessionId: run.session_id,
        toolExecution: "sequential",
        afterToolCall: async ({ toolCall }) => {
          if (["write_file", "run_command"].includes(toolCall.name)) await checkpoint();
          return undefined;
        },
      });

      activeRuns.set(run.id, agent);
      agent.subscribe(async (event) => {
        await this.handleAgentEvent({ event, run, writer, getParent: () => parentMessageId, setParent: (id) => (parentMessageId = id) });

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
      const finalCheckpoint = await checkpoint();

      if (finalCheckpoint) {
        const patchFile = await stat(finalCheckpoint.patchPath);
        const artifact = await saveArtifact({
          workspaceId: relation.workspace.id,
          sessionId: run.session_id,
          runId: run.id,
          name: "changes.patch",
          type: "git_patch",
          mimeType: "text/x-diff",
          storagePath: finalCheckpoint.patchPath,
          size: patchFile.size,
          metadata: { commit: finalCheckpoint.checkpointCommit, changedFiles: finalCheckpoint.changedFiles },
        });
        await writer.emit("artifact_created", { artifactId: artifact.id, name: artifact.name, type: artifact.type });
      }

      const status = agent.state.errorMessage?.toLowerCase().includes("abort") ? "cancelled" : "completed";
      await finishRun({ runId: run.id, status, inputTokens, outputTokens, costUsd });
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
      const stored = await createAgentMessage({
        sessionId: run.session_id,
        runId: run.id,
        parentMessageId: input.getParent(),
        role: "tool",
        blocks: toolBlocks(event.message),
      });
      input.setParent(stored.id);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.log.info(
        { runId: run.id, sessionId: run.session_id, toolCallId: event.toolCallId, toolName: event.toolName },
        "Agent tool started",
      );
      await startToolExecution({
        runId: run.id,
        callId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.args ?? {},
      });
      await writer.emit("tool_started", {
        callId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.args ?? {},
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const text = event.result?.content
        ?.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "[image]"))
        .join("\n");
      const toolLogData = {
        runId: run.id,
        sessionId: run.session_id,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultBytes: Buffer.byteLength(text ?? ""),
      };
      if (event.isError) this.log.warn(toolLogData, "Agent tool failed");
      else this.log.info(toolLogData, "Agent tool completed");
      await finishToolExecution({
        runId: run.id,
        callId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        result: { text: text ?? "", details: event.result?.details ?? null },
      });
      await writer.emit("tool_completed", {
        callId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: text?.slice(0, 20_000) ?? "",
      });
    }
  }
}

export const agentWorker = new AgentWorker();
