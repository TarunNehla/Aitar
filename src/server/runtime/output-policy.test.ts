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

  it("does not persist file contents or command text", () => {
    expect(safeToolArguments("write_file", { path: "src/a.ts", content: "secret source" }))
      .toEqual({ path: "src/a.ts" });
    expect(safeToolArguments("run_command", { command: "deploy --token secret", network: true }))
      .toEqual({ network: true });
    expect(persistedToolSummary({ toolName: "read_file", isError: false }).text)
      .toContain("contents were not stored");
  });

  it("bounds generic text without losing its end", () => {
    const result = boundedTail(`first-${"a".repeat(200)}-last`, 100);
    expect(result.text).not.toContain("first-");
    expect(result.text).toContain("-last");
  });
});
