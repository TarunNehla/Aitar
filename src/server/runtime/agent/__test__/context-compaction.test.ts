import { describe, expect, it, vi } from "vitest";
import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { contextCompactionEnvSchema } from "../../../config.js";
import {
  COMPACTION_PROMPT_VERSION,
  ContextCompactor,
  compactionLimit,
  estimateActiveContextTokens,
  isContextOverflowError,
  overheadTokens,
  planCompaction,
  prepareOverflowRetry,
  selectRecentUserMessages,
  snapshotForBranch,
  type ContextCompactorOptions,
  type SnapshotRecord,
} from "../context-compaction.js";

function usage(input = 1_000, output = 200, total = 0.01): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

let clock = 1_700_000_000_000;

function user(chars: number): AgentMessage {
  return { role: "user", content: "u".repeat(chars), timestamp: (clock += 1) };
}

function assistant(input: { chars?: number; toolCall?: string; usageTokens?: number } = {}): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (input.chars) content.push({ type: "text", text: "a".repeat(input.chars) });
  if (input.toolCall) content.push({ type: "toolCall", id: input.toolCall, name: "bash", arguments: {} });
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: input.usageTokens ? usage(input.usageTokens, 0) : usage(0, 0),
    stopReason: input.toolCall ? "toolUse" : "stop",
    timestamp: (clock += 1),
  };
}

function toolResult(callId: string, chars: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text: "r".repeat(chars) }],
    isError: false,
    timestamp: (clock += 1),
  };
}

interface Harness {
  compactor: ContextCompactor;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  snapshots: SnapshotRecord[];
  charged: Usage[];
  summarise: ReturnType<typeof vi.fn>;
  register: (messages: AgentMessage[], prefix?: string) => void;
}

function harness(overrides: Partial<ContextCompactorOptions> = {}): Harness {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const snapshots: SnapshotRecord[] = [];
  const charged: Usage[] = [];
  let summaries = 0;
  const summarise = vi.fn(async () => ({ text: `summary ${++summaries}`, usage: usage(8_000, 900, 0.02) }));

  const compactor = new ContextCompactor({
    model: "test/model",
    contextWindow: 1_000,
    thresholdPercent: 90,
    systemPrompt: () => "",
    tools: () => [],
    environment: () => "Repository: demo\nBase branch: main",
    keepRecentTokens: 200,
    summarise,
    saveSnapshot: async (record) => {
      snapshots.push(record);
      return { id: `snapshot-${snapshots.length}` };
    },
    emit: (type, payload) => {
      events.push({ type, payload });
    },
    onUsage: (value) => charged.push(value),
    now: () => clock,
    ...overrides,
  });

  return {
    compactor,
    events,
    snapshots,
    charged,
    summarise,
    register: (messages, prefix = "m") => {
      messages.forEach((message, index) => compactor.register(message, `${prefix}${index}`));
    },
  };
}

describe("compaction limit", () => {
  it("uses 90 percent of the context window by default", () => {
    const thresholdPercent = contextCompactionEnvSchema.parse({}).CONTEXT_COMPACTION_THRESHOLD_PERCENT;
    expect(thresholdPercent).toBe(90);
    expect(compactionLimit({ contextWindow: 200_000, thresholdPercent })).toBe(180_000);
  });

  it("honours a custom percentage and floors the result", () => {
    expect(compactionLimit({ contextWindow: 128_000, thresholdPercent: 75 })).toBe(96_000);
    expect(compactionLimit({ contextWindow: 1_001, thresholdPercent: 33 })).toBe(330);
  });

  it("uses only the percentage when no hard limit is configured", () => {
    expect(compactionLimit({ contextWindow: 200_000, thresholdPercent: 90, hardTokenLimit: undefined })).toBe(180_000);
  });

  it("takes the hard limit when it is lower than the percentage limit", () => {
    expect(compactionLimit({ contextWindow: 200_000, thresholdPercent: 90, hardTokenLimit: 50_000 })).toBe(50_000);
  });

  it("keeps the percentage limit when the hard limit is higher", () => {
    expect(compactionLimit({ contextWindow: 200_000, thresholdPercent: 90, hardTokenLimit: 500_000 })).toBe(180_000);
  });
});

describe("compaction environment validation", () => {
  it("defaults the threshold and the recent budget, and leaves the hard limit undefined", () => {
    const parsed = contextCompactionEnvSchema.parse({});
    expect(parsed.CONTEXT_COMPACTION_THRESHOLD_PERCENT).toBe(90);
    expect(parsed.CONTEXT_COMPACTION_KEEP_RECENT_TOKENS).toBe(20_000);
    expect(parsed.CONTEXT_COMPACTION_HARD_TOKEN_LIMIT).toBeUndefined();
  });

  it("accepts a custom recent budget and rejects one that is not a positive integer", () => {
    expect(
      contextCompactionEnvSchema.parse({ CONTEXT_COMPACTION_KEEP_RECENT_TOKENS: "8000" })
        .CONTEXT_COMPACTION_KEEP_RECENT_TOKENS,
    ).toBe(8_000);

    for (const value of ["0", "-1", "1.5", "lots"]) {
      expect(
        contextCompactionEnvSchema.safeParse({ CONTEXT_COMPACTION_KEEP_RECENT_TOKENS: value }).success,
        value,
      ).toBe(false);
    }
  });

  it("accepts a custom percentage and a positive hard limit", () => {
    const parsed = contextCompactionEnvSchema.parse({
      CONTEXT_COMPACTION_THRESHOLD_PERCENT: "70",
      CONTEXT_COMPACTION_HARD_TOKEN_LIMIT: "120000",
    });
    expect(parsed.CONTEXT_COMPACTION_THRESHOLD_PERCENT).toBe(70);
    expect(parsed.CONTEXT_COMPACTION_HARD_TOKEN_LIMIT).toBe(120_000);
  });

  it("rejects a percentage outside the allowed range", () => {
    for (const value of ["0", "-10", "101", "not-a-number"]) {
      expect(
        contextCompactionEnvSchema.safeParse({ CONTEXT_COMPACTION_THRESHOLD_PERCENT: value }).success,
        value,
      ).toBe(false);
    }
    expect(contextCompactionEnvSchema.safeParse({ CONTEXT_COMPACTION_THRESHOLD_PERCENT: "100" }).success).toBe(true);
  });

  it("rejects a hard limit that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(contextCompactionEnvSchema.safeParse({ CONTEXT_COMPACTION_HARD_TOKEN_LIMIT: value }).success, value).toBe(
        false,
      );
    }
  });
});

describe("context estimation", () => {
  it("counts system instructions and tool definitions", () => {
    const tools = [{ name: "bash", description: "runs a command", parameters: { type: "object" } as never }];
    const systemPrompt = "s".repeat(400);
    const overhead = overheadTokens(systemPrompt, tools);

    expect(overhead).toBe(Math.ceil((400 + "bash".length + "runs a command".length + '{"type":"object"}'.length) / 4));
    expect(estimateActiveContextTokens({ messages: [user(400)], overhead })).toBe(100 + overhead);
  });

  it("prefers provider usage that describes the context being measured", () => {
    const reported = assistant({ chars: 40, usageTokens: 5_000 });
    const messages = [user(400), reported, user(40)];
    expect(
      estimateActiveContextTokens({ messages, overhead: 0, reportsCurrentContext: (message) => message === reported }),
    ).toBe(5_010);
  });
});

describe("recent user message selection", () => {
  it("takes user messages newest first until the budget is spent", () => {
    const messages = [user(4_000), user(1_600), user(1_600), user(400)];

    const selected = selectRecentUserMessages(messages, 1_000);

    // 100 + 400 + 400 fits; the 1000-token message at the front does not.
    expect(selected).toEqual([messages[1], messages[2], messages[3]]);
    expect(selected.reduce((total, message) => total + estimateTokens(message), 0)).toBeLessThanOrEqual(1_000);
  });

  it("keeps the newest request even when it alone exceeds the budget", () => {
    const messages = [user(400), user(40_000)];

    const selected = selectRecentUserMessages(messages, 1_000);

    expect(selected).toEqual([messages[1]]);
  });

  it("skips an older request that would overshoot the budget", () => {
    const huge = user(40_000);
    const messages = [user(400), huge, user(400)];

    expect(selectRecentUserMessages(messages, 1_000)).toEqual([messages[2]]);
  });

  it("returns the requests in the order they were sent", () => {
    const messages = [user(40), user(40), user(40)];
    expect(selectRecentUserMessages(messages, 1_000)).toEqual(messages);
  });

  it("ignores everything that is not a real user message", () => {
    const messages = [
      user(40),
      assistant({ chars: 40, toolCall: "call-1" }),
      toolResult("call-1", 40),
      assistant({ chars: 40 }),
    ];

    expect(selectRecentUserMessages(messages, 1_000)).toEqual([messages[0]]);
  });
});

describe("compaction plan", () => {
  const ids = (messages: AgentMessage[]) => {
    const map = new Map(messages.map((message, index) => [message, `m${index}`]));
    return (message: AgentMessage) => map.get(message);
  };

  it("preserves only user requests and summarises everything else", () => {
    const messages = [
      user(4_000),
      assistant({ chars: 400, toolCall: "call-1" }),
      toolResult("call-1", 8_000),
      assistant({ chars: 400 }),
      user(400),
      assistant({ toolCall: "call-2" }),
      toolResult("call-2", 4_000),
    ];

    const plan = planCompaction({ messages, idFor: ids(messages), keepRecentTokens: 200 });

    expect(plan?.preserved).toEqual([messages[4]]);
    expect(plan?.summarise).toEqual([
      messages[0],
      messages[1],
      messages[2],
      messages[3],
      messages[5],
      messages[6],
    ]);
    expect(plan?.firstPreservedMessageId).toBe("m4");
    // The horizon is the newest message the summary covers, even though it is a tool result.
    expect(plan?.throughMessageId).toBe("m6");
  });

  it("summarises assistant work that came after the preserved request", () => {
    const messages = [user(400), assistant({ chars: 4_000 }), toolResult("call-1", 4_000)];

    const plan = planCompaction({ messages, idFor: ids(messages), keepRecentTokens: 20_000 });

    expect(plan?.preserved).toEqual([messages[0]]);
    expect(plan?.summarise).toEqual([messages[1], messages[2]]);
  });

  it("returns nothing when the context holds nothing but the preserved requests", () => {
    const messages = [user(40)];
    expect(planCompaction({ messages, idFor: ids(messages), keepRecentTokens: 200 })).toBeNull();
  });

  it("never preserves a user message that has no stored row", () => {
    const messages = [user(400), assistant({ chars: 400 }), user(40)];
    const stored = new Map<AgentMessage, string>([
      [messages[0], "m0"],
      [messages[1], "m1"],
    ]);

    const plan = planCompaction({ messages, idFor: (message) => stored.get(message), keepRecentTokens: 20_000 });

    expect(plan?.preserved).toEqual([messages[0]]);
    expect(plan?.summarise).toEqual([messages[1], messages[2]]);
    expect(plan?.firstPreservedMessageId).toBe("m0");
    expect(plan?.throughMessageId).toBe("m1");
  });
});

describe("compaction threshold", () => {
  it("compacts once the estimate reaches the limit exactly", async () => {
    const { compactor, register, summarise } = harness();
    const messages = [user(2_000), assistant({ chars: 800 }), user(800)];
    register(messages);

    expect(compactor.limit).toBe(900);
    expect(estimateActiveContextTokens({ messages, overhead: 0 })).toBe(900);

    await compactor.transformContext(messages);
    expect(summarise).toHaveBeenCalledTimes(1);
  });

  it("leaves the context alone one token below the limit", async () => {
    const { compactor, register, summarise } = harness();
    const messages = [user(2_000), assistant({ chars: 800 }), user(796)];
    register(messages);

    const result = await compactor.transformContext(messages);

    expect(summarise).not.toHaveBeenCalled();
    expect(result).toEqual(messages);
  });

  it("reports the hard limit as the reason when it triggers the compaction", async () => {
    const { compactor, register, snapshots } = harness({ contextWindow: 100_000, hardTokenLimit: 800 });
    const messages = [user(2_000), assistant({ chars: 800 }), user(800)];
    register(messages);

    await compactor.transformContext(messages);

    expect(snapshots[0].reason).toBe("hard_token_limit");
  });
});

describe("compaction", () => {
  const conversation = () => [
    user(2_000),
    assistant({ toolCall: "call-1" }),
    toolResult("call-1", 1_200),
    assistant({ chars: 400 }),
    user(800),
  ];

  it("replaces older history with fresh environment information and a summary", async () => {
    const { compactor, register, events, snapshots, charged } = harness();
    const messages = conversation();
    const original = [...messages];
    register(messages);

    const compacted = await compactor.transformContext(messages);

    expect(compacted[0].role).toBe("user");
    expect(String((compacted[0] as { content: string }).content)).toContain("<environment>");
    expect(compacted[1].role).toBe("compactionSummary");
    expect((compacted[1] as { summary: string }).summary).toBe("summary 1");
    expect(compacted.slice(2)).toEqual([messages[4]]);

    expect(events.map((event) => event.type)).toEqual(["compaction_started", "compaction_completed"]);
    expect(events[1].payload).toMatchObject({ snapshotId: "snapshot-1", reason: "threshold", preservedMessages: 1 });
    expect(events[1].payload.summary).toBeUndefined();

    expect(snapshots[0]).toMatchObject({
      previousSnapshotId: null,
      throughMessageId: "m4",
      firstPreservedMessageId: "m4",
      model: "test/model",
      reason: "threshold",
      promptVersion: COMPACTION_PROMPT_VERSION,
    });
    expect(snapshots[0].tokensBefore).toBeGreaterThan(snapshots[0].tokensAfter);
    expect(charged).toEqual([usage(8_000, 900, 0.02)]);

    // The transcript the console renders is never rewritten.
    expect(messages).toEqual(original);
  });

  it("keeps only the request when compaction happens between tool calls", async () => {
    const { compactor, register, summarise, snapshots } = harness();
    const messages = [
      user(2_000),
      assistant({ toolCall: "call-1" }),
      toolResult("call-1", 1_200),
      assistant({ toolCall: "call-2" }),
      toolResult("call-2", 800),
    ];
    register(messages);

    const compacted = await compactor.transformContext(messages);

    expect(summarise).toHaveBeenCalledTimes(1);
    expect(compacted.slice(2)).toEqual([messages[0]]);
    expect(compacted.some((message) => message.role === "toolResult" || message.role === "assistant")).toBe(false);
    // Tool calls and their results are both represented by the summary, so neither is orphaned.
    expect(summarise.mock.calls[0][0].messages).toEqual(messages.slice(1));
    expect(snapshots[0]).toMatchObject({ firstPreservedMessageId: "m0", throughMessageId: "m4" });
  });

  it("does not summarise the environment block or a previous summary again", async () => {
    const { compactor, register, summarise } = harness();
    const messages = conversation();
    register(messages);

    await compactor.transformContext(messages);
    const summarised = summarise.mock.calls[0][0].messages as AgentMessage[];

    expect(summarised).toEqual(messages.slice(0, 4));
    expect(summarised.some((message) => message.role === "compactionSummary")).toBe(false);
  });

  it("updates the previous summary instead of re-reading the whole transcript", async () => {
    const { compactor, register, summarise, snapshots } = harness();
    const messages = conversation();
    register(messages);
    await compactor.transformContext(messages);

    const later = [assistant({ chars: 2_000 }), user(1_600)];
    later.forEach((message, index) => compactor.register(message, `later${index}`));
    const transcript = [...messages, ...later];

    const compacted = await compactor.transformContext(transcript);

    expect(summarise).toHaveBeenCalledTimes(2);
    expect(summarise.mock.calls[1][0].previousSummary).toBe("summary 1");
    expect(summarise.mock.calls[1][0].messages).toEqual([messages[4], later[0]]);
    expect(snapshots[1]).toMatchObject({
      previousSnapshotId: "snapshot-1",
      throughMessageId: "later1",
      firstPreservedMessageId: "later1",
    });
    expect((compacted[1] as { summary: string }).summary).toBe("summary 2");
  });

  it("does not compact again on the next request just because the old usage was large", async () => {
    const { compactor, register, summarise } = harness();
    const messages = conversation();
    register(messages);
    const reported = assistant({ chars: 40, usageTokens: 5_000 });
    compactor.recordUsage(reported);
    compactor.register(reported, "reported");
    const transcript = [...messages, reported];

    await compactor.transformContext(transcript);
    await compactor.transformContext(transcript);

    expect(summarise).toHaveBeenCalledTimes(1);
  });

  it("compacts on request even when the estimate is below the limit", async () => {
    const { compactor, register, snapshots } = harness();
    const messages = conversation();
    register(messages);
    compactor.requestCompaction("context_overflow");

    await compactor.transformContext([messages[0], messages[1], messages[2], messages[3]]);

    expect(snapshots[0].reason).toBe("context_overflow");
  });
});

describe("failed compaction", () => {
  it("keeps the previous context, stores nothing, and reports the failure", async () => {
    const summarise = vi.fn(async () => {
      throw new Error("summarizer unavailable");
    });
    const { compactor, register, events, snapshots, charged } = harness({ summarise });
    const messages = [user(2_000), assistant({ chars: 800 }), user(800)];
    register(messages);

    const result = await compactor.transformContext(messages);

    expect(result).toEqual(messages);
    expect(snapshots).toHaveLength(0);
    expect(charged).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["compaction_started", "compaction_failed"]);
    expect(events[1].payload.error).toBe("summarizer unavailable");
    expect(compactor.activeSnapshot).toBeUndefined();
  });

  it("keeps the earlier snapshot when a later compaction fails", async () => {
    const { compactor, register, summarise } = harness();
    const messages = [user(2_000), assistant({ toolCall: "call-1" }), toolResult("call-1", 1_200), user(800)];
    register(messages);
    await compactor.transformContext(messages);

    summarise.mockRejectedValueOnce(new Error("provider error"));
    const later = [assistant({ chars: 2_000 }), user(1_600)];
    later.forEach((message, index) => compactor.register(message, `later${index}`));

    const result = await compactor.transformContext([...messages, ...later]);

    expect(compactor.activeSnapshot?.id).toBe("snapshot-1");
    expect((result[1] as { summary: string }).summary).toBe("summary 1");
    expect(result.slice(2)).toEqual([messages[3], ...later]);
  });

  it("keeps the context when the snapshot cannot be stored", async () => {
    const { compactor, register, events, charged } = harness({
      saveSnapshot: async () => {
        throw new Error("database unavailable");
      },
    });
    const messages = [user(2_000), assistant({ chars: 800 }), user(800)];
    register(messages);

    const result = await compactor.transformContext(messages);

    expect(result).toEqual(messages);
    expect(compactor.activeSnapshot).toBeUndefined();
    expect(events.at(-1)?.type).toBe("compaction_failed");
    // The summary was still paid for, so the run is charged for it.
    expect(charged).toHaveLength(1);
  });
});

describe("resuming a compacted chat", () => {
  it("rebuilds the preserved requests and keeps history added after the snapshot", async () => {
    const transcript = [
      user(2_000),
      assistant({ chars: 400 }),
      user(400),
      assistant({ toolCall: "call-1" }),
      toolResult("call-1", 400),
      user(400),
      assistant({ chars: 200 }),
    ];
    const { compactor, register, summarise } = harness({
      snapshot: {
        id: "snapshot-1",
        summary: "earlier work",
        throughMessageId: "m5",
        firstPreservedMessageId: "m2",
      },
    });
    register(transcript);

    const context = await compactor.transformContext(transcript);

    expect(summarise).not.toHaveBeenCalled();
    expect(String((context[0] as { content: string }).content)).toContain("Repository: demo");
    expect((context[1] as { summary: string }).summary).toBe("earlier work");
    // Only the user requests survive inside the snapshot range; everything after it stays verbatim.
    expect(context.slice(2)).toEqual([transcript[2], transcript[5], transcript[6]]);
  });

  it("falls back to the full history when the snapshot boundary is not on this branch", async () => {
    const transcript = [user(400), assistant({ chars: 400 })];
    const { compactor, register } = harness({
      snapshot: {
        id: "snapshot-1",
        summary: "earlier work",
        throughMessageId: "other-branch-1",
        firstPreservedMessageId: "other-branch-2",
      },
    });
    register(transcript);

    expect(await compactor.transformContext(transcript)).toEqual(transcript);
  });
});

describe("branch specific snapshots", () => {
  const snapshot = (id: string, through: string, firstPreserved: string, createdAt: string) => ({
    id,
    summary: `summary ${id}`,
    throughMessageId: through,
    firstPreservedMessageId: firstPreserved,
    createdAt: new Date(createdAt),
  });

  it("picks the newest snapshot whose boundaries sit on the branch", () => {
    const snapshots = [
      snapshot("old", "m1", "m2", "2026-01-01T00:00:00Z"),
      snapshot("new", "m5", "m6", "2026-01-02T00:00:00Z"),
    ];

    expect(snapshotForBranch(snapshots, ["m1", "m2", "m5", "m6"])).toMatchObject({ id: "new" });
    expect(snapshotForBranch(snapshots, ["m1", "m2", "m3"])).toMatchObject({
      id: "old",
      throughMessageId: "m1",
      firstPreservedMessageId: "m2",
    });
  });

  it("never reuses a snapshot from an abandoned branch", () => {
    const snapshots = [snapshot("abandoned", "b1", "b2", "2026-01-03T00:00:00Z")];
    expect(snapshotForBranch(snapshots, ["m1", "m2"])).toBeUndefined();
    // A half match is still another branch's snapshot.
    expect(snapshotForBranch(snapshots, ["b1", "m2"])).toBeUndefined();
  });
});

describe("context overflow recovery", () => {
  it("recognises provider overflow errors without matching unrelated failures", () => {
    for (const message of [
      "This endpoint's maximum context length is 128000 tokens",
      "context_length_exceeded: the request is too large",
      "Please reduce the length of the messages",
      "prompt is too long: 210000 tokens",
      "Request too large for model",
    ]) {
      expect(isContextOverflowError(message), message).toBe(true);
    }

    for (const message of ["rate limit exceeded", "insufficient credits", "connection reset", undefined]) {
      expect(isContextOverflowError(message), String(message)).toBe(false);
    }
  });

  it("drops the failed turn so the interrupted request can be retried", () => {
    const messages: AgentMessage[] = [user(40), assistant({ toolCall: "call-1" }), toolResult("call-1", 40)];
    const failure = assistant({ chars: 0 });
    failure.stopReason = "error";

    const retry = prepareOverflowRetry({
      errorMessage: "maximum context length is 128000 tokens",
      messages: [...messages, failure],
    });

    expect(retry).toEqual(messages);
  });

  it("does not retry a failure that is not an overflow", () => {
    const messages: AgentMessage[] = [user(40)];
    expect(prepareOverflowRetry({ errorMessage: "rate limit exceeded", messages })).toBeNull();
    expect(prepareOverflowRetry({ errorMessage: undefined, messages })).toBeNull();
  });

  it("does not retry when the transcript cannot be continued", () => {
    const messages: AgentMessage[] = [user(40), assistant({ chars: 40 })];
    expect(prepareOverflowRetry({ errorMessage: "prompt is too long", messages })).toBeNull();
  });

  it("compacts before the retried request", async () => {
    const { compactor, register, summarise, snapshots } = harness();
    const messages = [user(2_000), assistant({ toolCall: "call-1" }), toolResult("call-1", 200)];
    register(messages);
    const failure = assistant({ chars: 0 });
    failure.stopReason = "error";

    const retry = prepareOverflowRetry({
      errorMessage: "context_length_exceeded",
      messages: [...messages, failure],
    });
    expect(retry).toEqual(messages);

    compactor.requestCompaction("context_overflow");
    const context = await compactor.transformContext(retry as AgentMessage[]);

    expect(summarise).toHaveBeenCalledTimes(1);
    expect(snapshots[0].reason).toBe("context_overflow");
    // The interrupted tool call and its result are represented by the summary, not resent.
    expect(context.at(-1)).toBe(messages[0]);
    expect(summarise.mock.calls[0][0].messages).toEqual([messages[1], messages[2]]);
  });
});
