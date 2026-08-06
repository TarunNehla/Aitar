export type Role = "user" | "assistant" | "tool" | "system";

export type BlockType =
  | "text"
  | "code"
  | "reasoning_summary"
  | "tool_call"
  | "tool_result"
  | "file"
  | "image"
  | "error";

export interface SessionEvent {
  id: string;
  sessionId: string;
  runId: string | null;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  transient?: boolean;
}

export interface MessageBlockView {
  id: string;
  position: number;
  type: BlockType;
  text: string | null;
  data: Record<string, unknown>;
  visibility: "user" | "model" | "both" | "internal";
}

export interface MessageView {
  id: string;
  parentMessageId: string | null;
  role: Role;
  status: string;
  model: string | null;
  createdAt: string;
  blocks: MessageBlockView[];
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

export interface FileChange {
  status: FileChangeStatus;
  statusCode: string;
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

export interface CodeChanges {
  baseCommit: string;
  checkpointCommit: string;
  additions: number;
  deletions: number;
  files: FileChange[];
}
