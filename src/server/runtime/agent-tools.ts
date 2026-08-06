import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { approvalBroker } from "./approval-broker.js";
import { inspectCommand } from "./command-policy.js";
import type { EventWriter } from "./event-writer.js";
import { workspaceManager } from "./workspace-manager.js";
import { createApproval } from "../db/store.js";
import { logger } from "../logger.js";
import { commandResultText } from "./output-policy.js";

interface ToolContext {
  chatId: string;
  repositoryPath: string;
  sessionId: string;
  runId: string;
  baseCommit: string;
  writer: EventWriter;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createAgentTools(context: ToolContext): AgentTool[] {
  const toolLogger = logger.child({
    component: "agent-tools",
    runId: context.runId,
    sessionId: context.sessionId,
    chatId: context.chatId,
  });
  const listFiles: AgentTool = {
    name: "list_files",
    label: "List files",
    description: "List repository files. Use this before guessing file paths.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    execute: async (_callId, params: any) => {
      const files = await workspaceManager.listFiles(context.repositoryPath, Number(params.limit ?? 500));
      return textResult(files.join("\n"), { count: files.length });
    },
  };

  const readFile: AgentTool = {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the repository.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    execute: async (_callId, params: any) => {
      const path = String(params.path);
      const content = await workspaceManager.readFile(context.repositoryPath, path);
      toolLogger.debug({ path, bytes: Buffer.byteLength(content) }, "Repository file read");
      return textResult(content, { path });
    },
  };

  const searchFiles: AgentTool = {
    name: "search_files",
    label: "Search files",
    description: "Search repository text and return matching file names, line numbers, and lines.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    execute: async (_callId, params: any) => {
      const result = await workspaceManager.searchFiles(
        context.repositoryPath,
        String(params.query),
        Number(params.limit ?? 200),
      );
      return textResult(result || "No matches found.");
    },
  };

  const writeFile: AgentTool = {
    name: "write_file",
    label: "Write file",
    description: "Create or replace a UTF-8 text file inside the repository.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => {
      const path = String(params.path);
      const content = String(params.content);
      await workspaceManager.writeFile(context.repositoryPath, path, content);
      toolLogger.info({ path, bytes: Buffer.byteLength(content) }, "Repository file written");
      context.writer.live("file_changed", { path, operation: "write", bytes: Buffer.byteLength(content) });
      return textResult(`Wrote ${path}.`, { path, bytes: Buffer.byteLength(content) });
    },
  };

  const runCommand: AgentTool = {
    name: "run_command",
    label: "Run command",
    description:
      "Run a shell command inside the Docker sandbox. Network is off unless network=true, which requires user approval.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      network: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    execute: async (callId, params: any, signal, onUpdate) => {
      const command = String(params.command);
      const network = Boolean(params.network);
      const policy = inspectCommand(command, network);

      if (!policy.allowed) throw new Error(policy.reason);

      if (policy.approvalRequired) {
        toolLogger.warn({ toolCallId: callId, network }, "Sandbox command approval requested");
        const approval = await createApproval({
          sessionId: context.sessionId,
          runId: context.runId,
          reason: policy.reason ?? "User approval is required",
          command,
        });
        await context.writer.emit("approval_requested", {
          approvalId: approval.id,
          reason: approval.reason,
        });
        const approved = await approvalBroker.wait(approval.id, signal);
        if (approved) toolLogger.info({ toolCallId: callId }, "Sandbox command approval granted");
        else toolLogger.warn({ toolCallId: callId }, "Sandbox command approval denied");
        await context.writer.emit("approval_resolved", { approvalId: approval.id, approved });
        if (!approved) throw new Error("The user denied or did not answer the approval request");
      }

      const result = await workspaceManager.execute(context.chatId, context.repositoryPath, command, {
        signal,
        network,
        captureTail: true,
        onStdout: (chunk) => {
          context.writer.liveDelta("stdout_chunk", "chunk", chunk, { callId });
          onUpdate?.(textResult(chunk, { stream: "stdout" }));
        },
        onStderr: (chunk) => {
          context.writer.liveDelta("stderr_chunk", "chunk", chunk, { callId });
          onUpdate?.(textResult(chunk, { stream: "stderr" }));
        },
      });
      await context.writer.drain();

      const output = commandResultText(result);
      if (result.exitCode !== 0) {
        throw new Error(output.text || `Command exited with code ${result.exitCode}`);
      }
      return textResult(output.text, {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        outputTruncated: output.truncated,
      });
    },
  };

  const gitDiff: AgentTool = {
    name: "git_diff",
    label: "Git diff",
    description: "Show all repository changes made since the workspace base commit.",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await workspaceManager.execute(
        context.chatId,
        context.repositoryPath,
        `git diff --binary ${context.baseCommit}..HEAD && git diff --binary`,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || "Could not produce Git diff");
      return textResult(result.stdout || "No changes.");
    },
  };

  const finish: AgentTool = {
    name: "finish",
    label: "Finish",
    description: "Finish the current user request after work and verification are complete.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
    executionMode: "sequential",
    execute: async (_callId, params: any) => ({
      ...textResult(String(params.summary)),
      terminate: true,
    }),
  };

  return [listFiles, readFile, searchFiles, writeFile, runCommand, gitDiff, finish];
}
