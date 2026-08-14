const METADATA_PREVIEW_LIMIT = 500;
const PATTERN_PREVIEW_LIMIT = 200;
const URL_PREVIEW_LIMIT = 300;
const REFERENCE_PREVIEW_LIMIT = 60;
const ELEMENT_LABEL_LIMIT = 120;

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

const URL_SECRET_KEYS =
  /(?:token|secret|password|passwd|credential|api[-_]?key|auth|session|sig|signature|code|assertion)/i;

/**
 * A page URL reaches the chat and the event log, so anything a login flow or an
 * OAuth redirect parks in the query string or the fragment is stripped first.
 */
export function safeUrlPreview(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return metadataPreview(safeCommandPreview(raw), URL_PREVIEW_LIMIT);
  }

  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (URL_SECRET_KEYS.test(key)) parsed.searchParams.set(key, "[REDACTED]");
  }
  if (parsed.hash && URL_SECRET_KEYS.test(parsed.hash)) parsed.hash = "#[REDACTED]";
  return metadataPreview(parsed.toString(), URL_PREVIEW_LIMIT);
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

  if (toolName === "browser_navigate") {
    return {
      url: safeUrlPreview(args.url),
      ...(args.waitUntil === undefined ? {} : { waitUntil: metadataPreview(args.waitUntil, 20) }),
      ...(args.timeout === undefined ? {} : { timeout: optionalNumber(args.timeout) }),
    };
  }
  if (toolName === "browser_snapshot" || toolName === "browser_close") {
    return {};
  }
  if (toolName === "browser_click") {
    return { ref: metadataPreview(args.ref, REFERENCE_PREVIEW_LIMIT) };
  }
  if (toolName === "browser_type") {
    // Typed text is a password as often as not, so only its shape is recorded.
    return {
      ref: metadataPreview(args.ref, REFERENCE_PREVIEW_LIMIT),
      characters: typeof args.text === "string" ? args.text.length : 0,
      clear: Boolean(args.clear),
      submit: Boolean(args.submit),
      sensitive: Boolean(args.sensitive),
    };
  }
  if (toolName === "browser_select") {
    return {
      ref: metadataPreview(args.ref, REFERENCE_PREVIEW_LIMIT),
      values: Array.isArray(args.values) ? args.values.length : 0,
    };
  }
  if (toolName === "browser_press") {
    return { key: metadataPreview(args.key, 40) };
  }
  if (toolName === "browser_scroll") {
    return {
      direction: metadataPreview(args.direction, 10),
      ...(args.amount === undefined ? {} : { amount: optionalNumber(args.amount) }),
    };
  }
  if (toolName === "browser_wait") {
    return {
      ...(args.ref === undefined ? {} : { ref: metadataPreview(args.ref, REFERENCE_PREVIEW_LIMIT) }),
      ...(args.text === undefined ? {} : { text: metadataPreview(args.text, ELEMENT_LABEL_LIMIT) }),
      ...(args.timeout === undefined ? {} : { timeout: optionalNumber(args.timeout) }),
    };
  }
  if (toolName === "browser_screenshot") {
    return { fullPage: Boolean(args.fullPage) };
  }
  if (toolName === "browser_console") {
    return {
      ...(args.cursor === undefined ? {} : { cursor: metadataPreview(args.cursor, REFERENCE_PREVIEW_LIMIT) }),
      ...(args.level === undefined ? {} : { level: metadataPreview(args.level, 10) }),
      ...(args.limit === undefined ? {} : { limit: optionalNumber(args.limit) }),
    };
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

  if (input.toolName.startsWith("browser_")) {
    return browserSummary(input.toolName, status, details, args);
  }

  return { text: `${input.toolName.replaceAll("_", " ")} ${status}.`, data: {} };
}

/**
 * Page structure, console text, and typed values stay in the sidecar. Only the
 * action, its target, and its measurements are durable.
 */
function browserSummary(
  toolName: string,
  status: string,
  details: Record<string, unknown>,
  args: Record<string, unknown>,
): { text: string; data: Record<string, unknown> } {
  const durationMs = optionalNumber(details.durationMs);
  const label = metadataPreview(details.label, ELEMENT_LABEL_LIMIT);
  const url = safeUrlPreview(details.url ?? args.url);

  if (toolName === "browser_navigate") {
    const title = metadataPreview(details.title, ELEMENT_LABEL_LIMIT);
    const httpStatus = details.status === null ? null : optionalNumber(details.status);
    return {
      text: `Opened ${url || "a page"}${title ? ` (${title})` : ""}. Page content was not stored.`,
      data: {
        url,
        title,
        status: httpStatus ?? null,
        ...(durationMs === undefined ? {} : { durationMs }),
        timedOut: Boolean(details.timedOut),
      },
    };
  }

  if (toolName === "browser_snapshot") {
    const elements = optionalNumber(details.elements);
    return {
      text: `Read the page structure${measurements([
        elements === undefined ? null : `${elements.toLocaleString()} elements`,
      ])}. The page snapshot was not stored.`,
      data: { url, ...(elements === undefined ? {} : { elements }), truncated: Boolean(details.truncated) },
    };
  }

  if (toolName === "browser_click") {
    return {
      text: `Clicked “${label || "an element"}”${measurements([
        details.navigated ? "navigated" : null,
      ])}.`,
      data: { label, url, navigated: Boolean(details.navigated), ...(durationMs === undefined ? {} : { durationMs }) },
    };
  }

  if (toolName === "browser_type") {
    const characters = optionalNumber(details.characters ?? args.characters) ?? 0;
    return {
      text: `Typed [REDACTED] into “${label || "a field"}” (${characters} ${characters === 1 ? "character" : "characters"}). The typed value was not stored.`,
      data: {
        label,
        characters,
        redacted: true,
        submit: Boolean(details.submit ?? args.submit),
        navigated: Boolean(details.navigated),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    };
  }

  if (toolName === "browser_select") {
    const values = Array.isArray(details.values) ? details.values.map((value) => metadataPreview(value, 60)) : [];
    return {
      text: `Selected ${values.length > 0 ? values.map((value) => `“${value}”`).join(", ") : "an option"} in “${label || "a field"}”.`,
      data: { label, values, ...(durationMs === undefined ? {} : { durationMs }) },
    };
  }

  if (toolName === "browser_press") {
    const key = metadataPreview(details.key ?? args.key, 40);
    return {
      text: `Pressed ${key || "a key"}.`,
      data: { key, navigated: Boolean(details.navigated), ...(durationMs === undefined ? {} : { durationMs }) },
    };
  }

  if (toolName === "browser_scroll") {
    const direction = metadataPreview(details.direction ?? args.direction, 10);
    return {
      text: `Scrolled ${direction || "the page"}.`,
      data: { direction, x: optionalNumber(details.x), y: optionalNumber(details.y) },
    };
  }

  if (toolName === "browser_wait") {
    return {
      text: `Waited for the page${measurements([durationMs === undefined ? null : `${(durationMs / 1_000).toFixed(1)}s`])}.`,
      data: { matched: metadataPreview(details.matched, 20), ...(durationMs === undefined ? {} : { durationMs }) },
    };
  }

  if (toolName === "browser_screenshot") {
    const width = optionalNumber(details.width);
    const height = optionalNumber(details.height);
    const bytes = optionalNumber(details.bytes);
    return {
      text: `Captured a screenshot of ${url || "the page"}${measurements([
        width === undefined || height === undefined ? null : `${width}×${height}`,
        byteLabel(bytes),
      ])}. The image is stored as an artifact, not in the database.`,
      data: {
        artifactId: metadataPreview(details.artifactId, 64),
        url,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(bytes === undefined ? {} : { bytes }),
        fullPage: Boolean(details.fullPage),
        truncated: Boolean(details.truncated),
      },
    };
  }

  if (toolName === "browser_console") {
    const messages = optionalNumber(details.messages);
    const errors = optionalNumber(details.errors);
    return {
      text: `Read the browser console${measurements([
        messages === undefined ? null : `${messages.toLocaleString()} messages`,
        errors === undefined ? null : `${errors.toLocaleString()} errors`,
      ])}. Console text was not stored.`,
      data: {
        ...(messages === undefined ? {} : { messages }),
        ...(errors === undefined ? {} : { errors }),
        nextCursor: metadataPreview(details.nextCursor, 64),
        remaining: optionalNumber(details.remaining),
      },
    };
  }

  if (toolName === "browser_close") {
    return { text: "Closed the browser.", data: { closed: Boolean(details.closed) } };
  }

  return { text: `${toolName.replaceAll("_", " ")} ${status}.`, data: {} };
}
