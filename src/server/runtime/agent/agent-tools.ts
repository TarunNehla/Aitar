import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { switchChatBaseBranch } from "../workspace/base-branch.js";
import { createBrowserTools } from "../browser/browser-tools.js";
import type { EventWriter } from "../../events/event-writer.js";
import { createPullRequestForChat } from "../workspace/pull-request.js";
import { effectiveTimeoutSeconds, platformTimeoutSeconds, runSandboxCommand } from "../sandbox/sandbox-command.js";
import { SandboxOperations } from "../sandbox/sandbox-operations.js";
import { processManager } from "../sandbox/sandbox-processes.js";
import { resolveWorkspacePath, WORKSPACE_PATH, workspaceRelativePath } from "../sandbox/sandbox.js";
import type { RunVisionRouter } from "../model/vision-router.js";

export interface ToolContext {
  chatId: string;
  repositoryPath: string;
  sessionId: string;
  runId: string;
  writer: EventWriter;
  vision: RunVisionRouter;
}

type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function requestedPath(params: unknown): string {
  const value = (params as { path?: unknown } | undefined)?.path;
  return typeof value === "string" ? value : ".";
}

/** Adds the metadata the console and the event log need, without touching tool output. */
function withDetails(tool: AgentTool, enrich: (params: any, result: ToolResult) => Record<string, unknown>): AgentTool {
  return {
    ...tool,
    execute: async (callId, params, signal, onUpdate) => {
      const result = await tool.execute(callId, params, signal, onUpdate);
      const existing = result.details && typeof result.details === "object" ? result.details : {};
      return { ...result, details: { ...existing, ...enrich(params, result) } };
    },
  };
}

export function createAgentTools(context: ToolContext): AgentTool[] {
  const toolLogger = logger.child({
    component: "agent-tools",
    runId: context.runId,
    sessionId: context.sessionId,
    chatId: context.chatId,
  });
  const operations = new SandboxOperations(context.chatId, context.repositoryPath);

  const read = withDetails(
    createReadTool(WORKSPACE_PATH, { operations: operations.read, autoResizeImages: true }),
    (params) => ({
      path: workspaceRelativePath(resolveWorkspacePath(requestedPath(params))),
      bytes: operations.lastRead?.bytes,
      lines: operations.lastRead?.lines,
    }),
  );

  const edit = withDetails(
    createEditTool(WORKSPACE_PATH, { operations: operations.edit }),
    (params) => {
      const path = workspaceRelativePath(resolveWorkspacePath(requestedPath(params)));
      const edits = Array.isArray(params?.edits) ? params.edits.length : 0;
      context.writer.live("file_changed", { path, operation: "edit", edits });
      return { path, edits, bytes: operations.lastWrite?.bytes };
    },
  );

  const write = withDetails(
    createWriteTool(WORKSPACE_PATH, { operations: operations.write }),
    (params) => {
      const path = workspaceRelativePath(resolveWorkspacePath(requestedPath(params)));
      const bytes = typeof params?.content === "string" ? Buffer.byteLength(params.content) : undefined;
      context.writer.live("file_changed", { path, operation: "write", bytes });
      return { path, bytes };
    },
  );

  /** Counts the listed lines while ignoring the factories' notice and empty-result sentinels. */
  const countedLines = (result: ToolResult, sentinels: string[]) =>
    result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .split("\n")
      .filter((line) => line && !line.startsWith("[") && !sentinels.includes(line)).length;

  const find = withDetails(
    createFindTool(WORKSPACE_PATH, { operations: operations.find }),
    (params, result) => ({
      pattern: String(params?.pattern ?? ""),
      path: workspaceRelativePath(resolveWorkspacePath(requestedPath(params))),
      results: countedLines(result, ["No files found matching pattern"]),
    }),
  );

  const list = withDetails(
    createLsTool(WORKSPACE_PATH, { operations: operations.ls }),
    (params, result) => ({
      path: workspaceRelativePath(resolveWorkspacePath(requestedPath(params))),
      entries: countedLines(result, ["(empty directory)"]),
    }),
  );

  const grep: AgentTool = {
    name: "grep",
    label: "grep",
    description:
      "Search file contents inside the workspace and return matching lines with paths and line numbers. " +
      "Output is bounded, so narrow the search with path, glob, or limit when a pattern is broad.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, description: "Search pattern (regular expression, or literal when literal is true)" }),
      path: Type.Optional(Type.String({ description: "File or directory to search, relative to the repository root" })),
      glob: Type.Optional(Type.String({ description: "Only search files matching this glob, for example '*.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string" })),
      context: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Lines of context around each match" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1_000, description: "Maximum matches to return (default 100)" })),
    }),
    execute: async (_callId, params: any, signal) => {
      const outcome = await operations.grep(
        {
          pattern: String(params.pattern),
          path: params.path === undefined ? undefined : String(params.path),
          glob: params.glob === undefined ? undefined : String(params.glob),
          ignoreCase: Boolean(params.ignoreCase),
          literal: Boolean(params.literal),
          context: params.context === undefined ? undefined : Number(params.context),
          limit: params.limit === undefined ? undefined : Number(params.limit),
        },
        signal,
      );
      return textResult(outcome.text, {
        pattern: String(params.pattern),
        matches: outcome.matches,
        files: outcome.files,
        truncated: outcome.truncated,
      });
    },
  };

  const bash: AgentTool = {
    name: "bash",
    label: "bash",
    description:
      `Run a shell command in the container for this chat, always from ${WORKSPACE_PATH}. ` +
      "The container has outbound internet access, so package installs and network requests work. " +
      `Commands are stopped after ${platformTimeoutSeconds()} seconds. Use start_process for anything long-lived.`,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command to run" }),
      timeout: Type.Optional(
        Type.Number({ minimum: 1, description: `Timeout in seconds, capped at ${platformTimeoutSeconds()}` }),
      ),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal) => {
      const command = String(params.command);
      const outcome = await runSandboxCommand({
        chatId: context.chatId,
        repositoryPath: context.repositoryPath,
        command,
        timeout: params.timeout === undefined ? undefined : Number(params.timeout),
        signal,
        onStdout: (chunk) => context.writer.liveDelta("stdout_chunk", "chunk", chunk, { callId }),
        onStderr: (chunk) => context.writer.liveDelta("stderr_chunk", "chunk", chunk, { callId }),
      });
      await context.writer.drain();

      const details = {
        command,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        stdoutBytes: outcome.stdoutBytes,
        stderrBytes: outcome.stderrBytes,
        truncated: outcome.truncated,
      };

      if (outcome.status === "aborted") throw new Error(`${outcome.text}\n\nCommand cancelled`.trim());
      if (outcome.status === "timeout") {
        throw new Error(
          `${outcome.text}\n\nCommand timed out after ${effectiveTimeoutSeconds(params.timeout)} seconds`.trim(),
        );
      }
      if (outcome.exitCode !== 0) {
        throw new Error(`${outcome.text}\n\nCommand exited with code ${outcome.exitCode}`.trim());
      }
      return textResult(outcome.text || "(no output)", details);
    },
  };

  const startProcess: AgentTool = {
    name: "start_process",
    label: "start process",
    description:
      "Start a long-running command, such as a dev server or a watcher, in the background inside this chat's container. " +
      "Returns a processId for process_logs and stop_process.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Command to run in the background" }),
      name: Type.Optional(Type.String({ minLength: 1, description: "Short label for this process" })),
    }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => {
      const command = String(params.command);
      const started = await processManager.start({
        chatId: context.chatId,
        repositoryPath: context.repositoryPath,
        command,
        name: params.name === undefined ? undefined : String(params.name),
      });
      toolLogger.info({ processId: started.processId, name: started.name }, "Managed process requested");
      return textResult(
        `Started ${started.name} as ${started.processId}. Read its output with process_logs.`,
        { processId: started.processId, name: started.name, command },
      );
    },
  };

  const processLogs: AgentTool = {
    name: "process_logs",
    label: "process logs",
    description:
      "Read new output from a managed process. Pass the cursor from the previous call to continue where you stopped.",
    parameters: Type.Object({
      processId: Type.String({ minLength: 1, description: "Process id returned by start_process" }),
      cursor: Type.Optional(Type.String({ description: "Cursor from the previous process_logs call" })),
      limit: Type.Optional(Type.Number({ minimum: 512, description: "Maximum bytes to return per stream" })),
    }),
    execute: async (_callId, params: any) => {
      const logs = await processManager.logs({
        chatId: context.chatId,
        processId: String(params.processId),
        cursor: params.cursor === undefined ? undefined : String(params.cursor),
        limit: params.limit === undefined ? undefined : Number(params.limit),
      });
      const sections = [
        `status: ${logs.state}${logs.exitCode === null ? "" : ` (exit ${logs.exitCode})`}`,
        logs.stdout ? `stdout:\n${logs.stdout}` : "stdout: (no new output)",
        logs.stderr ? `stderr:\n${logs.stderr}` : "stderr: (no new output)",
        `cursor: ${logs.nextCursor}${logs.truncated ? " (more output is waiting)" : ""}`,
      ];
      return textResult(sections.join("\n\n"), {
        processId: logs.processId,
        name: logs.name,
        state: logs.state,
        exitCode: logs.exitCode,
        nextCursor: logs.nextCursor,
        truncated: logs.truncated,
        stdoutBytes: logs.stdoutBytes,
        stderrBytes: logs.stderrBytes,
      });
    },
  };

  const stopProcess: AgentTool = {
    name: "stop_process",
    label: "stop process",
    description: "Stop a managed process. Use force to send SIGKILL instead of SIGTERM.",
    parameters: Type.Object({
      processId: Type.String({ minLength: 1, description: "Process id returned by start_process" }),
      force: Type.Optional(Type.Boolean({ description: "Kill the process immediately" })),
    }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => {
      const stopped = await processManager.stop({
        chatId: context.chatId,
        processId: String(params.processId),
        force: Boolean(params.force),
      });
      return textResult(`Stopped ${stopped.name}.`, {
        processId: stopped.processId,
        name: stopped.name,
        state: stopped.state,
        exitCode: stopped.exitCode,
        force: Boolean(params.force),
      });
    },
  };

  const switchBaseBranch: AgentTool = {
    name: "switch_base_branch",
    label: "switch base branch",
    description:
      "Start this chat from a different branch of the same repository. " +
      "Use it only when the user explicitly asks to work from another branch, and never as a way to inspect one. " +
      "The platform re-creates the checkout at that branch, so it works only while the chat has no changes yet. " +
      "A git checkout in bash does not change where this chat's work belongs.",
    parameters: Type.Object({
      branch: Type.String({ minLength: 1, maxLength: 200, description: "Existing branch in this repository" }),
    }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => {
      const outcome = await switchChatBaseBranch({
        sessionId: context.sessionId,
        branch: String(params.branch),
      });
      toolLogger.info({ baseBranch: outcome.baseBranch, changed: outcome.changed }, "Chat base branch requested");
      return textResult(
        outcome.changed
          ? `This chat now starts from ${outcome.baseBranch}. The checkout was re-created, so any process you started has stopped.`
          : `This chat already starts from ${outcome.baseBranch}.`,
        { changed: outcome.changed },
      );
    },
  };

  const createPullRequest: AgentTool = {
    name: "create_pull_request",
    label: "create pull request",
    description:
      "Publish this chat's work and open a pull request against the branch it started from. " +
      "The platform picks the repository and the commit, and places the branch you name. " +
      "Calling this again updates the same branch and returns the existing pull request.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 240, description: "Pull request title" }),
      branchName: Type.String({
        minLength: 1,
        maxLength: 80,
        description:
          "Short kebab-case name for the change, such as fix-login-screen-flicker. Describe what the diff does, " +
          "not what the conversation was about. The platform namespaces it and appends a chat suffix, and ignores " +
          "it once this chat has already published.",
      }),
      body: Type.Optional(Type.String({ maxLength: 60_000, description: "Pull request description in Markdown" })),
      draft: Type.Optional(Type.Boolean({ description: "Open the pull request as a draft" })),
    }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => {
      const outcome = await createPullRequestForChat({
        sessionId: context.sessionId,
        runId: context.runId,
        repositoryPath: context.repositoryPath,
        title: String(params.title),
        branchName: String(params.branchName),
        body: params.body === undefined ? undefined : String(params.body),
        draft: Boolean(params.draft),
        writer: context.writer,
      });
      const verb = outcome.reused ? "Reused existing pull request" : "Created pull request";
      return textResult(`${verb} #${outcome.number}: ${outcome.url}`, {
        number: outcome.number,
        url: outcome.url,
        state: outcome.state,
        draft: outcome.draft,
        title: outcome.title,
        reused: outcome.reused,
      });
    },
  };

  const browser = config.BROWSER_ENABLED
    ? createBrowserTools({
        chatId: context.chatId,
        repositoryPath: context.repositoryPath,
        runId: context.runId,
        vision: context.vision,
        writer: context.writer,
      })
    : [];

  return [
    read,
    edit,
    write,
    grep,
    find,
    list,
    bash,
    startProcess,
    processLogs,
    stopProcess,
    switchBaseBranch,
    createPullRequest,
    ...browser,
  ];
}
