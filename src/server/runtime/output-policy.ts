const METADATA_PREVIEW_LIMIT = 500;
const PATTERN_PREVIEW_LIMIT = 200;

function metadataPreview(value: unknown, maximumCharacters = METADATA_PREVIEW_LIMIT): string {
  const text = String(value ?? "").trim();
  if (text.length <= maximumCharacters) return text;
  return `${text.slice(0, maximumCharacters - 1)}…`;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function byteLabel(value: unknown): string | null {
  const bytes = optionalNumber(value);
  if (bytes === undefined || bytes < 0) return null;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function measurements(parts: Array<string | null>): string {
  const joined = parts.filter(Boolean).join(", ");
  return joined ? ` (${joined})` : "";
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
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g, "[REDACTED]");
}

/**
 * Everything the database is allowed to see from a tool call. File contents,
 * patch text, command output, and process logs never appear here.
 */
export function safeToolArguments(toolName: string, value: unknown): Record<string, unknown> {
  const args = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const path = () => metadataPreview(args.path);

  if (toolName === "read") {
    return {
      path: path(),
      ...(args.offset === undefined ? {} : { offset: optionalNumber(args.offset) }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
  }
  if (toolName === "edit") {
    return { path: path(), edits: Array.isArray(args.edits) ? args.edits.length : 0 };
  }
  if (toolName === "write") {
    return {
      path: path(),
      bytes: typeof args.content === "string" ? Buffer.byteLength(args.content) : undefined,
    };
  }
  if (toolName === "grep") {
    return {
      pattern: metadataPreview(args.pattern, PATTERN_PREVIEW_LIMIT),
      ...(args.path === undefined ? {} : { path: path() }),
      ...(args.glob === undefined ? {} : { glob: metadataPreview(args.glob, PATTERN_PREVIEW_LIMIT) }),
      ...(args.ignoreCase === undefined ? {} : { ignoreCase: Boolean(args.ignoreCase) }),
      ...(args.literal === undefined ? {} : { literal: Boolean(args.literal) }),
      ...(args.context === undefined ? {} : { context: optionalNumber(args.context) }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
  }
  if (toolName === "find") {
    return {
      pattern: metadataPreview(args.pattern, PATTERN_PREVIEW_LIMIT),
      ...(args.path === undefined ? {} : { path: path() }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
  }
  if (toolName === "ls") {
    return {
      ...(args.path === undefined ? {} : { path: path() }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
  }
  if (toolName === "bash") {
    return {
      command: safeCommandPreview(args.command),
      ...(args.timeout === undefined ? {} : { timeout: optionalNumber(args.timeout) }),
    };
  }
  if (toolName === "start_process") {
    return {
      command: safeCommandPreview(args.command),
      ...(args.name === undefined ? {} : { name: metadataPreview(args.name, 60) }),
    };
  }
  if (toolName === "process_logs") {
    return {
      processId: metadataPreview(args.processId, 64),
      ...(args.cursor === undefined ? {} : { cursor: metadataPreview(args.cursor, 64) }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
  }
  if (toolName === "stop_process") {
    return { processId: metadataPreview(args.processId, 64), force: Boolean(args.force) };
  }
  if (toolName === "create_pull_request") {
    return { title: metadataPreview(args.title, 240), draft: Boolean(args.draft) };
  }
  return {};
}

export function persistedToolSummary(input: {
  toolName: string;
  isError: boolean;
  details?: unknown;
  arguments?: unknown;
}): { text: string; data: Record<string, unknown> } {
  const details = input.details && typeof input.details === "object"
    ? (input.details as Record<string, unknown>)
    : {};
  const args = input.arguments && typeof input.arguments === "object"
    ? (input.arguments as Record<string, unknown>)
    : {};
  const status = input.isError ? "failed" : "completed";
  const preview = (key: string, limit = METADATA_PREVIEW_LIMIT) =>
    metadataPreview(args[key] ?? details[key], limit);

  if (input.toolName === "read") {
    const path = preview("path") || "unknown file";
    const lines = optionalNumber(details.lines);
    const bytes = optionalNumber(details.bytes);
    return {
      text: `Read ${path}${measurements([
        lines === undefined ? null : `${lines.toLocaleString()} lines`,
        byteLabel(bytes),
      ])}. File contents were not stored.`,
      data: { path, ...(lines === undefined ? {} : { lines }), ...(bytes === undefined ? {} : { bytes }) },
    };
  }

  if (input.toolName === "edit") {
    const path = preview("path") || "unknown file";
    const edits = optionalNumber(args.edits ?? details.edits) ?? 0;
    return {
      text: `Edited ${path} (${edits} ${edits === 1 ? "edit" : "edits"}). The patch is generated from Git when requested.`,
      data: { path, edits },
    };
  }

  if (input.toolName === "write") {
    const path = preview("path") || "unknown file";
    const bytes = optionalNumber(args.bytes ?? details.bytes);
    return {
      text: `Wrote ${path}${measurements([byteLabel(bytes)])}. File contents were not stored.`,
      data: { path, ...(bytes === undefined ? {} : { bytes }) },
    };
  }

  if (input.toolName === "grep") {
    const pattern = preview("pattern", PATTERN_PREVIEW_LIMIT) || "unknown pattern";
    const matches = optionalNumber(details.matches);
    const files = optionalNumber(details.files);
    return {
      text: `Searched for “${pattern}”${measurements([
        matches === undefined ? null : `${matches.toLocaleString()} matches`,
        files === undefined ? null : `${files.toLocaleString()} files`,
      ])}. Search results were not stored.`,
      data: {
        pattern,
        ...(matches === undefined ? {} : { matches }),
        ...(files === undefined ? {} : { files }),
        ...(details.truncated === undefined ? {} : { truncated: Boolean(details.truncated) }),
      },
    };
  }

  if (input.toolName === "find") {
    const pattern = preview("pattern", PATTERN_PREVIEW_LIMIT) || "unknown pattern";
    const results = optionalNumber(details.results);
    return {
      text: `Found files matching “${pattern}”${measurements([
        results === undefined ? null : `${results.toLocaleString()} results`,
      ])}.`,
      data: { pattern, ...(results === undefined ? {} : { results }) },
    };
  }

  if (input.toolName === "ls") {
    const path = preview("path") || ".";
    const entries = optionalNumber(details.entries);
    return {
      text: `Listed ${path}${measurements([entries === undefined ? null : `${entries.toLocaleString()} entries`])}.`,
      data: { path, ...(entries === undefined ? {} : { entries }) },
    };
  }

  if (input.toolName === "bash") {
    const command = safeCommandPreview(args.command ?? details.command) || "unknown command";
    const exitCode = details.exitCode === null ? null : optionalNumber(details.exitCode);
    return {
      text: `Command ${status}: ${command}. Exit code ${exitCode === null || exitCode === undefined ? "unknown" : exitCode}. Command output was not stored.`,
      data: {
        command,
        exitCode: exitCode ?? null,
        durationMs: optionalNumber(details.durationMs),
        stdoutBytes: optionalNumber(details.stdoutBytes),
        stderrBytes: optionalNumber(details.stderrBytes),
        truncated: Boolean(details.truncated),
      },
    };
  }

  if (input.toolName === "start_process") {
    const name = metadataPreview(details.name ?? args.name, 60) || "process";
    const command = safeCommandPreview(args.command ?? details.command);
    const processId = metadataPreview(details.processId, 64);
    return {
      text: `Started ${name}${processId ? ` as ${processId}` : ""}. Process logs stay in the sandbox.`,
      data: { name, processId, command },
    };
  }

  if (input.toolName === "process_logs") {
    const name = metadataPreview(details.name, 60) || "process";
    const stdoutBytes = optionalNumber(details.stdoutBytes);
    const stderrBytes = optionalNumber(details.stderrBytes);
    return {
      text: `Read ${name} logs${measurements([
        byteLabel(stdoutBytes) ? `${byteLabel(stdoutBytes)} stdout` : null,
        byteLabel(stderrBytes) ? `${byteLabel(stderrBytes)} stderr` : null,
      ])}. Log contents were not stored.`,
      data: {
        name,
        processId: metadataPreview(details.processId ?? args.processId, 64),
        state: metadataPreview(details.state, 20),
        exitCode: details.exitCode === undefined ? null : details.exitCode,
        ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
        ...(stderrBytes === undefined ? {} : { stderrBytes }),
        truncated: Boolean(details.truncated),
      },
    };
  }

  if (input.toolName === "stop_process") {
    const name = metadataPreview(details.name, 60) || "process";
    return {
      text: `Stopped ${name}.`,
      data: {
        name,
        processId: metadataPreview(details.processId ?? args.processId, 64),
        state: metadataPreview(details.state, 20),
        force: Boolean(args.force ?? details.force),
      },
    };
  }

  if (input.toolName === "create_pull_request") {
    const number = optionalNumber(details.number);
    const reused = Boolean(details.reused);
    return {
      text: number === undefined
        ? `Pull request ${status}.`
        : `${reused ? "Reused" : "Created"} pull request #${number}.`,
      data: {
        ...(number === undefined ? {} : { number }),
        url: metadataPreview(details.url, 300),
        state: metadataPreview(details.state, 20),
        draft: Boolean(details.draft),
        title: metadataPreview(details.title ?? args.title, 240),
        headBranch: metadataPreview(details.headBranch, 200),
        baseBranch: metadataPreview(details.baseBranch, 200),
        reused,
      },
    };
  }

  return { text: `${input.toolName.replaceAll("_", " ")} ${status}.`, data: {} };
}
