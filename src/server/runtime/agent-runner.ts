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
import { modelCapabilities } from "./model-capability.js";
import { applyProviderRouting, configuredProviderPreferences } from "./openrouter-routing.js";
import { RunCostAccount } from "./run-cost.js";
import { createRunVisionRouter, recoverFromUnsupportedImage } from "./vision-router.js";
import { workspaceManager } from "./workspace-manager.js";
import { persistedToolSummary, safeToolArguments } from "./output-policy.js";

/** Tools whose calls are worth replaying after a reload, so they reach Postgres as summaries. */
const durableTools = new Set([
  "bash",
  "write",
  "edit",
  "start_process",
  "stop_process",
  "create_pull_request",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_press",
  "browser_screenshot",
  "browser_close",
  "inspect_image",
]);

const systemPrompt = [
  "You are a coding agent working inside an isolated container for one repository checkout.",
  "The repository is always at /workspace and every tool runs there.",
  "",
  "Tools:",
  "- read, ls, find, and grep inspect the checkout. Read a file before editing it.",
  "- edit applies exact string replacements. write creates a file or replaces it completely.",
  "- bash runs a shell command from /workspace. The container has outbound internet access, so installs and network requests work without asking.",
  "- start_process, process_logs, and stop_process manage long-running commands such as dev servers. Never start those with bash.",
  "- create_pull_request publishes this chat's work and opens the pull request. It is the only way to push.",
  "- switch_base_branch moves this chat onto another branch of the same repository, and only while the chat has no changes.",
  "- browser_navigate, browser_snapshot, browser_click, browser_type, browser_select, browser_press, browser_scroll, browser_wait, browser_screenshot, inspect_image, browser_console, and browser_close drive a real Chromium browser for this chat. Use them to run the application, navigate the interface, test user flows, read console errors, capture screenshots, and confirm visual results.",
  "",
  "Seeing the page:",
  "- browser_snapshot is the primary way to understand a page. Use it for visible text, buttons, links, forms, element references, page structure, and navigation.",
  "- browser_screenshot is for how the page looks: layout, colours, spacing, overlapping elements, responsive behaviour, charts, images, and visual comparison. Do not take a screenshot when a snapshot answers the question.",
  "- Always pass a focused question with a screenshot, such as “Is the heading centred and is any text overflowing?”. A screenshot without a question is answered only in general terms.",
  "- inspect_image asks a new question about a screenshot you already captured. Pass the artifactId from the earlier browser_screenshot result instead of capturing the same page again.",
  "- The platform decides how each image is read, and routes it to a vision model when necessary. Never assume or state whether you can see images yourself, and never skip a screenshot because you think you cannot read it.",
  "- Capture a final screenshot with a question after you finish a change that alters the user interface.",
  "",
  "Browser rules:",
  "- Start the application with start_process, then wait for the server to report that it is listening before opening it.",
  "- An application you intend to check in the browser must listen on 0.0.0.0 rather than only on 127.0.0.1, because the browser runs beside the container rather than inside it.",
  "- Still pass ordinary localhost URLs such as http://localhost:3000 to browser_navigate. The platform routes them to this chat.",
  "- Use the browser tools rather than curl whenever you are verifying a user interface.",
  "- Call browser_snapshot before clicking or typing, and act on the references it returns instead of guessed selectors or coordinates.",
  "- Read browser_console when a page misbehaves.",
  "- Call browser_close once the browser is no longer needed.",
  "- Skip the browser entirely for work that does not affect a user interface.",
  "",
  "Working rules:",
  "- Make focused changes that satisfy the request, then verify them by running the project's tests or checks.",
  "",
  "Git rules:",
  "- The checkout sits on a detached HEAD at the commit this chat started from. That is expected: this chat has no local branch and does not need one.",
  "- The platform commits your work as checkpoints. Do not commit, branch, merge, rebase, reset, stash, or push yourself.",
  "- Use git through bash for local inspection such as status, diff, log, and show. Do not configure remotes or credentials.",
  "- Never use git checkout, git switch, or git branch to move the chat onto another branch. The platform tracks which branch this chat started from, and a bash checkout does not update it. Call switch_base_branch instead, and only when the user asks for another branch.",
  "- Stop any process you started once you no longer need it.",
  "- When the work is done, reply with a short summary of what changed instead of calling another tool.",
].join("\n");

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
    const cost = new RunCostAccount(run.max_cost_usd);
    let turns = 0;
    let parentMessageId = relation.session.currentLeafMessageId;
    let repositoryPath = "";

    const checkpoint = async () => {
      if (!repositoryPath) return null;
      // Re-read the head: switch_base_branch can move it while the run is working.
      const current = await getSession(relation.session.id);
      const runBaseCommit = current?.session.headCommit ?? current?.session.baseCommit;
      if (!runBaseCommit) return null;
      const result = await workspaceManager.checkpoint({
        chatId: relation.session.id,
        repositoryId: relation.repository.id,
        repositoryPath,
        runId: run.id,
        baseCommit: runBaseCommit,
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

      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: "starting" });
      const checkout = await withRepositoryGitAccess({ repository: relation.repository }, (gitEnvironment) =>
        workspaceManager.ensureChatCheckout({
          chatId: relation.session.id,
          repositoryId: relation.repository.id,
          repositoryUrl: relation.repository.repositoryUrl,
          baseBranch: relation.session.baseBranch,
          baseCommit: relation.session.baseCommit,
          headCommit: relation.session.headCommit,
          gitEnvironment,
        }),
      );
      repositoryPath = checkout.repository;
      await updateSessionEnvironment({
        sessionId: relation.session.id,
        envStatus: "ready",
        baseCommit: checkout.baseCommit,
        headCommit: checkout.headCommit,
      });

      const capability = await modelCapabilities.capabilityOf(run.model);
      await writer.emit("run_started", {
        model: run.model,
        workerId: this.workerId,
        imageInput: capability.supportsImages,
        capabilitySource: capability.source,
        visionRoutingMode: config.VISION_ROUTING_MODE,
      });
      runLog.info(
        { imageInput: capability.supportsImages, capabilitySource: capability.source },
        "Model image capability resolved",
      );

      const branch = await getActiveBranchMessages(run.session_id);
      const history = branch.map(toPiMessage).filter((message): message is AgentMessage => Boolean(message));
      const model: Model<any> = {
        ...modelFor(run.model),
        input: capability.supportsImages ? ["text", "image"] : ["text"],
      };
      const vision = createRunVisionRouter({
        primaryModelId: capability.modelId || run.model,
        supportsImages: capability.supportsImages,
        cost,
        complete: models.completeSimple.bind(models),
        apiKey: () => config.OPENROUTER_API_KEY,
        onPayload: applyProviderRouting,
      });
      const tools = createAgentTools({
        chatId: relation.session.id,
        repositoryPath,
        sessionId: run.session_id,
        runId: run.id,
        writer,
        vision,
      });

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
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
          cost.addModelUsage(event.message.usage);
          if (cost.exceededBudget()) agent.abort();
        }
      });

      await agent.continue();
      await writer.drain();
      const demoted = await recoverFromUnsupportedImage({
        errorMessage: agent.state.errorMessage,
        vision,
        chatId: relation.session.id,
        emit: (type, payload) => writer.emit(type, payload),
        steer: (text) => agent.steer({ role: "user", content: text, timestamp: Date.now() }),
      });
      if (demoted) {
        model.input.splice(0, model.input.length, "text");
        await agent.continue();
        await writer.drain();
      }
      if (agent.state.errorMessage && !agent.state.errorMessage.toLowerCase().includes("abort")) {
        throw new Error(agent.state.errorMessage);
      }
      await checkpoint();

      const status = agent.state.errorMessage?.toLowerCase().includes("abort") ? "cancelled" : "completed";
      const { visionCostUsd, visionRequests, ...usage } = cost.totals();
      await finishRun({ runId: run.id, status, ...usage });
      await updateSessionEnvironment({ sessionId: relation.session.id, envStatus: "ready" });
      await writer.emit("run_completed", { status, ...usage, visionCostUsd, visionRequests, turns });
      runLog.info(
        { status, ...usage, visionCostUsd, visionRequests, turns, durationMs: Date.now() - startedAt },
        "Agent run finished",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { visionCostUsd, visionRequests, ...usage } = cost.totals();
      runLog.error(
        { error: errorForLog(error), ...usage, visionCostUsd, visionRequests, turns, durationMs: Date.now() - startedAt },
        "Agent run failed",
      );
      try {
        await checkpoint();
      } catch {
        // Preserve the original run error.
      }
      await finishRun({ runId: run.id, status: "failed", ...usage, error: message });
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
      const durable = durableTools.has(event.toolName);
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
      const durable = durableTools.has(event.toolName);
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
