import { describe, expect, it } from "vitest";
import { boundedTail, commandResultText, persistedToolSummary, safeToolArguments } from "./output-policy.js";

describe("agent output persistence", () => {
  it("keeps only the tail of large command output", () => {
    const result = commandResultText({
      stdout: `start-${"x".repeat(20_000)}-done`,
      stderr: "",
      stdoutBytes: 20_011,
      stderrBytes: 0,
      durationMs: 1_250,
      exitCode: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("start-");
    expect(result.text).toContain("-done");
  });

  it("persists useful tool metadata without file contents or command secrets", () => {
    expect(safeToolArguments("write_file", { path: "src/a.ts", content: "secret source" }))
      .toEqual({ path: "src/a.ts" });
    expect(safeToolArguments("run_command", { command: "deploy --token secret", network: true }))
      .toEqual({ command: "deploy --token [REDACTED]", network: true });

    const readSummary = persistedToolSummary({
      toolName: "read_file",
      isError: false,
      arguments: { path: "src/a.ts" },
      details: { bytes: 2_048, lines: 42 },
    });
    expect(readSummary.text).toContain("src/a.ts");
    expect(readSummary.text).toContain("42 lines");
    expect(readSummary.text).toBe("Read src/a.ts (42 lines, 2.0 KB).");
  });

  it("keeps search and command metadata in their summaries", () => {
    const searchSummary = persistedToolSummary({
      toolName: "search_files",
      isError: false,
      arguments: { query: "TODO" },
      details: { matches: 7 },
    });
    expect(searchSummary.data).toEqual({ query: "TODO", matches: 7 });

    const commandSummary = persistedToolSummary({
      toolName: "run_command",
      isError: false,
      arguments: { command: "pnpm test" },
      details: { exitCode: 0, durationMs: 800, stdoutBytes: 12, stderrBytes: 0 },
    });
    expect(commandSummary.data.command).toBe("pnpm test");

    const listSummary = persistedToolSummary({
      toolName: "list_files",
      isError: false,
      details: { count: 2, files: ["src/a.ts", "src/b.ts"] },
    });
    expect(listSummary.data).toEqual({ count: 2, files: ["src/a.ts", "src/b.ts"] });
  });

  it("bounds generic text without losing its end", () => {
    const result = boundedTail(`first-${"a".repeat(200)}-last`, 100);
    expect(result.text).not.toContain("first-");
    expect(result.text).toContain("-last");
  });
});
