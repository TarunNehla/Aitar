import { describe, expect, it, vi } from "vitest";
import { Agent, convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { ContextCompactor, type SummariseFn } from "./context-compaction.js";

const model: Model<"openai-completions"> = {
  id: "test/model",
  name: "test model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
}

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: model.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function userMessage(chars: number): { role: "user"; content: string; timestamp: number } {
  return { role: "user", content: "u".repeat(chars), timestamp: Date.now() };
}

function toolCall(callId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }],
    api: "openai-completions",
    provider: "openrouter",
    model: model.id,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolOutput(callId: string, chars: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text: "r".repeat(chars) }],
    isError: false,
    timestamp: Date.now(),
  };
}

function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => ("text" in block ? block.text : "")).join("");
}

describe("compaction inside a run", () => {
  it("sends the summary instead of the older history and leaves the transcript alone", async () => {
    const history = [userMessage(2_400), userMessage(800), userMessage(800)];
    const summarise = vi.fn(async () => ({ text: "what happened earlier", usage: usage() }));
    const compactor = new ContextCompactor({
      model: model.id,
      contextWindow: model.contextWindow,
      thresholdPercent: 90,
      systemPrompt: () => "you are a coding agent",
      tools: () => [],
      environment: () => "Repository: demo",
      keepRecentTokens: 200,
      summarise,
      saveSnapshot: async () => ({ id: "snapshot-1" }),
      emit: () => {},
    });
    history.forEach((message, index) => compactor.register(message, `m${index}`));

    const requests: Message[][] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "you are a coding agent", model, tools: [], messages: history },
      convertToLlm,
      transformContext: (messages, signal) => compactor.transformContext(messages, signal),
      streamFn: (_model, context) => {
        requests.push(context.messages);
        const stream = createAssistantMessageEventStream();
        const message = reply("done");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        compactor.recordUsage(event.message);
      }
    });

    await agent.continue();

    expect(summarise).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(text(sent[0])).toContain("<environment>");
    expect(text(sent[1])).toContain("what happened earlier");
    expect(sent).toHaveLength(3);
    expect(text(sent[2])).toBe(history[2].content);
    expect(sent.some((message) => text(message) === history[0].content)).toBe(false);

    // The agent still owns every original message, plus the reply.
    expect(agent.state.messages.slice(0, 3)).toEqual(history);
    expect(agent.state.messages).toHaveLength(4);
  });

  it("sends the provider nothing but the environment, the summary and recent user requests", async () => {
    const history: AgentMessage[] = [
      userMessage(2_400),
      toolCall("call-1"),
      toolOutput("call-1", 4_000),
      userMessage(800),
    ];
    const summarise = vi.fn(async (_input: Parameters<SummariseFn>[0]) => ({
      text: "earlier work",
      usage: usage(),
    }));
    const compactor = new ContextCompactor({
      model: model.id,
      contextWindow: model.contextWindow,
      thresholdPercent: 90,
      systemPrompt: () => "",
      tools: () => [],
      environment: () => "Repository: demo",
      keepRecentTokens: 200,
      summarise,
      saveSnapshot: async () => ({ id: "snapshot-1" }),
      emit: () => {},
    });
    history.forEach((message, index) => compactor.register(message, `m${index}`));

    const requests: Message[][] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "", model, tools: [], messages: history },
      convertToLlm,
      transformContext: (messages, signal) => compactor.transformContext(messages, signal),
      streamFn: (_model, context) => {
        requests.push(context.messages);
        const stream = createAssistantMessageEventStream();
        const message = reply("done");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });

    await agent.continue();

    const sent = requests[0];
    expect(sent.every((message) => message.role === "user")).toBe(true);
    expect(sent).toHaveLength(3);
    expect(text(sent[2])).toBe((history[3] as { content: string }).content);
    expect(summarise.mock.calls[0][0].messages).toEqual([history[0], history[1], history[2]]);
  });

  it("reuses the summary for the next request instead of compacting again", async () => {
    const history = [userMessage(2_400), userMessage(800), userMessage(800)];
    const summarise = vi.fn(async () => ({ text: "what happened earlier", usage: usage() }));
    const compactor = new ContextCompactor({
      model: model.id,
      contextWindow: model.contextWindow,
      thresholdPercent: 90,
      systemPrompt: () => "",
      tools: () => [],
      environment: () => "Repository: demo",
      keepRecentTokens: 200,
      summarise,
      saveSnapshot: async () => ({ id: "snapshot-1" }),
      emit: () => {},
    });
    history.forEach((message, index) => compactor.register(message, `m${index}`));

    const requests: Message[][] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "", model, tools: [], messages: history },
      convertToLlm,
      transformContext: (messages, signal) => compactor.transformContext(messages, signal),
      streamFn: (_model, context) => {
        requests.push(context.messages);
        const stream = createAssistantMessageEventStream();
        const message = reply("done");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });

    await agent.continue();
    const followUp: AgentMessage = { role: "user", content: "carry on", timestamp: Date.now() };
    await agent.prompt(followUp);

    expect(summarise).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(text(requests[1][1])).toContain("what happened earlier");
    expect(text(requests[1].at(-1) as Message)).toBe("carry on");
    expect(requests[1].some((message) => text(message) === history[0].content)).toBe(false);
  });
});
