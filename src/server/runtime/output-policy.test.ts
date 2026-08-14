import { describe, expect, it } from "vitest";
import { persistedToolSummary, safeCommandPreview, safeToolArguments } from "./output-policy.js";

const toolNames = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "bash",
  "start_process",
  "process_logs",
  "stop_process",
  "create_pull_request",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_press",
  "browser_scroll",
  "browser_wait",
  "browser_screenshot",
  "inspect_image",
  "browser_console",
  "browser_close",
];

describe("persisted tool arguments", () => {
  it("keeps file contents and patch text out of the database", () => {
    expect(safeToolArguments("write", { path: "src/a.ts", content: "secret source" }))
      .toEqual({ path: "src/a.ts", bytes: 13 });
    expect(safeToolArguments("edit", {
      path: "src/a.ts",
      edits: [{ oldText: "secret before", newText: "secret after" }],
    })).toEqual({ path: "src/a.ts", edits: 1 });
    expect(safeToolArguments("read", { path: "src/a.ts", offset: 10, limit: 20 }))
      .toEqual({ path: "src/a.ts", offset: 10, limit: 20 });
  });

  it("redacts credentials from commands", () => {
    expect(safeToolArguments("bash", { command: "deploy --token secret" }))
      .toEqual({ command: "deploy --token [REDACTED]" });
    expect(safeToolArguments("start_process", { command: "API_KEY=abc123 pnpm dev", name: "dev-server" }))
      .toEqual({ command: "API_KEY=[REDACTED] pnpm dev", name: "dev-server" });
    expect(safeCommandPreview("git push https://ghp_abcdefghijklmnopqrstuvwx@github.com/a/b"))
      .toContain("[REDACTED]");
    expect(safeCommandPreview("curl -H 'Authorization: Bearer sk-live-123456'")).toContain("[REDACTED]");
  });

  it("never invents arguments for an unknown tool", () => {
    expect(safeToolArguments("unknown_tool", { secret: "value" })).toEqual({});
  });

  it("keeps the pull request body out of the database", () => {
    expect(safeToolArguments("create_pull_request", { title: "Add caching", body: "diff --git a b", draft: true }))
      .toEqual({ title: "Add caching", draft: true });
  });
});

describe("persisted tool summaries", () => {
  it("summarises reads with counts instead of contents", () => {
    const summary = persistedToolSummary({
      toolName: "read",
      isError: false,
      arguments: { path: "src/a.ts" },
      details: { bytes: 2_048, lines: 42 },
    });
    expect(summary.text).toBe("Read src/a.ts (42 lines, 2.0 KB). File contents were not stored.");
    expect(summary.data).toEqual({ path: "src/a.ts", lines: 42, bytes: 2_048 });
  });

  it("summarises searches, commands, processes, and pull requests", () => {
    expect(persistedToolSummary({
      toolName: "grep",
      isError: false,
      arguments: { pattern: "TODO" },
      details: { matches: 7, files: 3, truncated: false },
    }).data).toEqual({ pattern: "TODO", matches: 7, files: 3, truncated: false });

    const command = persistedToolSummary({
      toolName: "bash",
      isError: false,
      arguments: { command: "pnpm test" },
      details: { exitCode: 0, durationMs: 800, stdoutBytes: 12, stderrBytes: 0, truncated: false },
    });
    expect(command.data.command).toBe("pnpm test");
    expect(command.data.exitCode).toBe(0);
    expect(command.text).toContain("Command output was not stored");

    expect(persistedToolSummary({
      toolName: "process_logs",
      isError: false,
      details: { name: "dev-server", processId: "abc", stdoutBytes: 900, stderrBytes: 0, state: "running" },
    }).text).toContain("Log contents were not stored");

    expect(persistedToolSummary({
      toolName: "create_pull_request",
      isError: false,
      details: { number: 42, url: "https://github.com/a/b/pull/42", state: "open", draft: false, reused: false },
    })).toMatchObject({ text: "Created pull request #42." });
  });

  it("summarises a cancelled command without an exit code", () => {
    const summary = persistedToolSummary({
      toolName: "bash",
      isError: true,
      arguments: { command: "sleep 600" },
      details: { exitCode: null, durationMs: 1_000, stdoutBytes: 0, stderrBytes: 0, truncated: false },
    });
    expect(summary.text).toContain("Exit code unknown");
    expect(summary.data.exitCode).toBeNull();
  });

  it("produces a summary for every tool without leaking payloads", () => {
    const payload = "SUPER_SECRET_FILE_CONTENT";
    for (const toolName of toolNames) {
      const summary = persistedToolSummary({
        toolName,
        isError: false,
        arguments: { content: payload, body: payload, oldText: payload },
        details: { content: payload, output: payload, stdout: payload, logs: payload },
      });
      expect(summary.text, toolName).toBeTruthy();
      expect(JSON.stringify(summary), toolName).not.toContain(payload);
    }
  });

  it("keeps image bytes and prompts out of a screenshot summary while persisting routing metadata", () => {
    const summary = persistedToolSummary({
      toolName: "browser_screenshot",
      isError: false,
      arguments: { fullPage: true, question: "Is the heading centred?" },
      details: {
        artifactId: "artifact-1",
        url: "http://localhost:3000/",
        width: 1_280,
        height: 800,
        bytes: 188_416,
        fullPage: true,
        truncated: false,
        question: "Is the heading centred?",
        primaryModel: "deepseek/deepseek-v4-flash-0731",
        routing: "delegated",
        structured: true,
        visionModel: "google/gemini-3.7-flash",
        visionInputTokens: 1_100,
        visionOutputTokens: 240,
        visionCostUsd: 0.0009,
        visionDurationMs: 2_400,
        confidence: 0.82,
        visualProblems: 1,
        visionSummary: "The heading is centred and no text overflows.",
        base64: "SU1BR0VCWVRFUw==",
        image: "SU1BR0VCWVRFUw==",
      },
    });

    expect(JSON.stringify(summary)).not.toContain("SU1BR0VCWVRFUw==");
    expect(summary.text).toContain("Inspected by google/gemini-3.7-flash");
    expect(summary.data).toEqual({
      artifactId: "artifact-1",
      url: "http://localhost:3000/",
      width: 1_280,
      height: 800,
      bytes: 188_416,
      fullPage: true,
      truncated: false,
      question: "Is the heading centred?",
      primaryModel: "deepseek/deepseek-v4-flash-0731",
      routing: "delegated",
      structured: true,
      visionModel: "google/gemini-3.7-flash",
      visionInputTokens: 1_100,
      visionOutputTokens: 240,
      visionCostUsd: 0.0009,
      visionDurationMs: 2_400,
      confidence: 0.82,
      visualProblems: 1,
      visionSummary: "The heading is centred and no text overflows.",
    });
  });

  it("records a direct screenshot without inventing a vision model", () => {
    const summary = persistedToolSummary({
      toolName: "browser_screenshot",
      isError: false,
      arguments: { fullPage: false },
      details: { artifactId: "artifact-1", routing: "direct", structured: false, visionDurationMs: 1 },
    });
    expect(summary.text).toContain("read the image directly");
    expect(summary.data.visionModel).toBeUndefined();
    expect(summary.data.visionCostUsd).toBeUndefined();
  });

  it("bounds the question and the visual summary it persists", () => {
    const summary = persistedToolSummary({
      toolName: "inspect_image",
      isError: false,
      arguments: { artifactId: "artifact-1", question: "q".repeat(2_000) },
      details: {
        artifactId: "artifact-1",
        mimeType: "image/png",
        bytes: 1_024,
        routing: "delegated",
        visionModel: "google/gemini-3.7-flash",
        visionSummary: "s".repeat(4_000),
      },
    });

    expect(String(summary.data.question).length).toBeLessThanOrEqual(400);
    expect(String(summary.data.visionSummary).length).toBeLessThanOrEqual(600);
    expect(summary.text).toContain("Inspected screenshot artifact-1");
    expect(summary.text).toContain("The image and the question were not stored.");
  });

  it("keeps the artifact id and the question but nothing else from inspect_image arguments", () => {
    expect(
      safeToolArguments("inspect_image", {
        artifactId: "artifact-1",
        question: "Do the cards line up?",
        image: "SU1BR0VCWVRFUw==",
      }),
    ).toEqual({ artifactId: "artifact-1", question: "Do the cards line up?" });
  });

  it("keeps the screenshot question but nothing else from screenshot arguments", () => {
    expect(safeToolArguments("browser_screenshot", { fullPage: true, question: "Any overflow?", secret: "nope" }))
      .toEqual({ fullPage: true, question: "Any overflow?" });
    expect(safeToolArguments("browser_screenshot", { fullPage: false })).toEqual({ fullPage: false });
  });
});
