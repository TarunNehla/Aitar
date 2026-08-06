const SUCCESS_OUTPUT_LIMIT = 12_000;
const FAILURE_OUTPUT_LIMIT = 24_000;

export function boundedTail(value: string, maximumCharacters: number) {
  const originalBytes = Buffer.byteLength(value);
  if (value.length <= maximumCharacters) return { text: value, truncated: false, originalBytes };
  const notice = `[Earlier output removed. Showing the final part of ${originalBytes.toLocaleString()} bytes.]\n`;
  return {
    text: `${notice}${value.slice(-(maximumCharacters - notice.length))}`,
    truncated: true,
    originalBytes,
  };
}

export function commandResultText(input: {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  exitCode: number;
}) {
  const output = [input.stdout, input.stderr].filter(Boolean).join("\n").trim();
  const totalBytes = input.stdoutBytes + input.stderrBytes;
  if (!output) {
    return {
      text: `Command completed with exit code ${input.exitCode} in ${(input.durationMs / 1_000).toFixed(1)}s and produced no output.`,
      truncated: false,
      originalBytes: totalBytes,
    };
  }
  const result = boundedTail(output, input.exitCode === 0 ? SUCCESS_OUTPUT_LIMIT : FAILURE_OUTPUT_LIMIT);
  if (!result.truncated) return { ...result, originalBytes: totalBytes };
  return {
    ...result,
    text: `Command finished with exit code ${input.exitCode} in ${(input.durationMs / 1_000).toFixed(1)}s.\n${result.text}`,
    originalBytes: totalBytes,
  };
}

export function persistedToolSummary(input: {
  toolName: string;
  isError: boolean;
  details?: unknown;
}): { text: string; data: Record<string, unknown> } {
  const details = input.details && typeof input.details === "object"
    ? input.details as Record<string, unknown>
    : {};
  const status = input.isError ? "failed" : "completed";

  if (input.toolName === "read_file") {
    return { text: `File read ${status}. File contents were not stored.`, data: {} };
  }
  if (input.toolName === "search_files") {
    return { text: `File search ${status}. Search results were not stored.`, data: {} };
  }
  if (input.toolName === "list_files") {
    return { text: `File listing ${status}. The listing was not stored.`, data: { count: details.count } };
  }
  if (input.toolName === "git_diff") {
    return { text: `Git diff ${status}. The patch is generated from Git when requested.`, data: {} };
  }
  if (input.toolName === "run_command") {
    return {
      text: `Command ${status} with exit code ${String(details.exitCode ?? "unknown")}. Full output was not stored.`,
      data: {
        exitCode: details.exitCode,
        durationMs: details.durationMs,
        stdoutBytes: details.stdoutBytes,
        stderrBytes: details.stderrBytes,
      },
    };
  }
  return { text: `${input.toolName.replaceAll("_", " ")} ${status}.`, data: {} };
}

export function safeToolArguments(toolName: string, value: unknown): Record<string, unknown> {
  const args = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (toolName === "write_file") return { path: args.path };
  if (toolName === "run_command") return { network: Boolean(args.network) };
  if (["read_file", "search_files", "list_files", "git_diff"].includes(toolName)) return {};
  if (toolName === "finish") return {};
  return {};
}
