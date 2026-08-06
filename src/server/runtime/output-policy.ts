const SUCCESS_OUTPUT_LIMIT = 12_000;
const FAILURE_OUTPUT_LIMIT = 24_000;
const METADATA_PREVIEW_LIMIT = 500;

function metadataPreview(value: unknown, maximumCharacters = METADATA_PREVIEW_LIMIT): string {
  const text = String(value ?? "").trim();
  if (text.length <= maximumCharacters) return text;
  return `${text.slice(0, maximumCharacters - 1)}…`;
}

function byteLabel(value: unknown): string | null {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function safeCommandPreview(value: unknown): string {
  return metadataPreview(value)
    .replace(
      /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(--?(?:api[-_]?key|token|secret|password|passwd|credential)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]");
}

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
  arguments?: unknown;
}): { text: string; data: Record<string, unknown> } {
  const details = input.details && typeof input.details === "object"
    ? input.details as Record<string, unknown>
    : {};
  const args = input.arguments && typeof input.arguments === "object"
    ? input.arguments as Record<string, unknown>
    : {};
  const status = input.isError ? "failed" : "completed";

  if (input.toolName === "read_file") {
    const path = metadataPreview(args.path ?? details.path) || "unknown file";
    const bytes = Number(details.bytes);
    const lines = Number(details.lines);
    const measurements = [
      Number.isFinite(lines) ? `${lines.toLocaleString()} lines` : null,
      byteLabel(bytes),
    ].filter(Boolean).join(", ");
    return {
      text: `Read ${path}${measurements ? ` (${measurements})` : ""}.`,
      data: { path, ...(Number.isFinite(bytes) ? { bytes } : {}), ...(Number.isFinite(lines) ? { lines } : {}) },
    };
  }
  if (input.toolName === "search_files") {
    const query = metadataPreview(args.query ?? details.query, 200) || "unknown query";
    const matches = Number(details.matches);
    return {
      text: `Searched for “${query}”${Number.isFinite(matches) ? ` and found ${matches.toLocaleString()} matching lines` : ""}. Search results were not stored.`,
      data: { query, ...(Number.isFinite(matches) ? { matches } : {}) },
    };
  }
  if (input.toolName === "list_files") {
    const files = Array.isArray(details.files)
      ? details.files.slice(0, 500).map((file) => metadataPreview(file))
      : [];
    const count = Number(details.count);
    return {
      text: `Listed ${Number.isFinite(count) ? count.toLocaleString() : files.length.toLocaleString()} files.`,
      data: { count: Number.isFinite(count) ? count : files.length, files },
    };
  }
  if (input.toolName === "write_file") {
    const path = metadataPreview(args.path ?? details.path) || "unknown file";
    const bytes = Number(details.bytes);
    return {
      text: `Wrote ${path}${byteLabel(bytes) ? ` (${byteLabel(bytes)})` : ""}.`,
      data: { path, ...(Number.isFinite(bytes) ? { bytes } : {}) },
    };
  }
  if (input.toolName === "git_diff") {
    return { text: `Git diff ${status}. The patch is generated from Git when requested.`, data: {} };
  }
  if (input.toolName === "run_command") {
    const command = safeCommandPreview(args.command ?? details.command) || "unknown command";
    return {
      text: `Command ${status}: ${command}. Exit code ${String(details.exitCode ?? "unknown")}. Full output was not stored.`,
      data: {
        command,
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
  if (toolName === "write_file" || toolName === "read_file") {
    return { path: metadataPreview(args.path) };
  }
  if (toolName === "search_files") {
    return {
      query: metadataPreview(args.query, 200),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    };
  }
  if (toolName === "run_command") {
    return { command: safeCommandPreview(args.command), network: Boolean(args.network) };
  }
  if (["list_files", "git_diff"].includes(toolName)) return {};
  if (toolName === "finish") return {};
  return {};
}
