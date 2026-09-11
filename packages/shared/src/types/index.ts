// "acp" is a local-agent channel: it stores an ACP agent launch config
// (command/args/env, JSON-encoded in the apiKey slot) instead of provider
// credentials, and only the desktop agent runtime consumes it.
export type ChannelProtocol = "openai" | "anthropic" | "google" | "acp";
export type Provider = string;

export interface Channel {
  id: string;
  userId: string;
  name: string;
  provider: Provider;
  protocol: ChannelProtocol;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  channelId?: string;
  title: string;
  systemPrompt?: string;
  contextLength: number;
  isPinned: boolean;
  /** Sidebar project the conversation is filed under; null/undefined = plain chat list. */
  projectId?: string | null;
  /** ImportSource id when the conversation was imported; null/undefined otherwise. */
  importedFrom?: string | null;
  importedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A local folder the user added to the sidebar. Conversations filed under a
 * project run their agent turns with `rootPath` as the sidecar workspace root.
 */
export interface Project {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  isStarred: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  attachments?: Attachment[];
  createdAt: Date;
}

export interface Attachment {
  id: string;
  conversationId?: string;
  messageId?: string;
  fileName: string;
  filePath: string;
  fileType: string;
  fileSize: number;
  createdAt: Date;
}

/**
 * Normalized attachment payload shared between the desktop composer and the
 * sidecar agent runtimes. Images carry base64 bytes for vision-capable models;
 * files carry already-extracted UTF-8 text (text/code/JSON or PDF text pulled
 * client-side via pdf.js) so every runtime can inject them as plain context.
 */
export type AttachmentPart =
  | { kind: "image"; mediaType: string; dataBase64: string; fileName?: string }
  | { kind: "file"; fileName: string; mediaType: string; text: string };

export interface AgentSession {
  id: string;
  userId: string;
  channelId?: string;
  title: string;
  status: "active" | "completed" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

export interface MCPServer {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  /** ImportSource id when the server entry was imported; null/undefined otherwise. */
  importedFrom?: string | null;
  importedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillFile {
  id: string;
  path: string;
  content: string;
  isBinary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  isEnabled: boolean;
  files?: SkillFile[];
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CredentialProvider = "openai" | "anthropic" | "google";
export type CredentialSourceType = "env_var" | "cli_oauth" | "manual";
export type CredentialStatus = "available" | "expired" | "error";

export interface CredentialSource {
  id: string;
  provider: CredentialProvider;
  sourceType: CredentialSourceType;
  sourceName: string;
  status: CredentialStatus;
  error?: string;
}

export type ScheduledTaskFrequency =
  | "daily"
  | "weekly_mon"
  | "weekly_tue"
  | "weekly_wed"
  | "weekly_thu"
  | "weekly_fri"
  | "weekly_sat"
  | "weekly_sun";

export type ScheduledTaskRunStatus = "pending" | "running" | "completed" | "failed";

export interface ScheduledTask {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  frequency: ScheduledTaskFrequency;
  time: string;
  enabled: boolean;
  notifyOnComplete: boolean;
  channelId?: string;
  modelId?: string;
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  userId: string;
  status: ScheduledTaskRunStatus;
  conversationId?: string;
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  taskTitle?: string;
}

export interface ProviderPreset {
  protocol: ChannelProtocol;
  baseUrl: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Import center (settings → 导入)
// ---------------------------------------------------------------------------

/** Where an import came from. `file` = backup zip / ChatGPT / Claude.ai export picked by the user. */
export type ImportSource =
  | "claude-code"
  | "codex"
  | "gemini"
  | "cc-switch"
  | "opencode"
  | "cursor"
  | "vscode"
  | "claude-desktop"
  | "continue"
  | "file";

export type ImportKind = "local" | "backup" | "chatgpt" | "claude-export";

/**
 * Top-level import units. Messages are never a part of their own — a
 * conversation item carries its message count in `detail` / the part `note`,
 * so `totalImported` counts conversations, not the messages inside them.
 */
export type ImportPartType =
  | "conversations"
  | "mcp"
  | "skills"
  | "instructions"
  | "prompts"
  | "credentials"
  | "channels"
  | "projects"
  | "scheduledTasks"
  | "settings"
  | "attachments";

export type ImportPartItemStatus = "imported" | "skipped" | "needsAction";

export type ImportPartLinkKind =
  | "conversation"
  | "mcp"
  | "skill"
  | "channel"
  | "project"
  | "settings-tab"
  | "prompt";

export interface ImportPartItem {
  label: string;
  detail?: string;
  status: ImportPartItemStatus;
  link?: { kind: ImportPartLinkKind; id?: string };
}

export interface ImportPart {
  type: ImportPartType;
  imported: number;
  skipped: number;
  needsAction: number;
  note?: string;
  /** At most IMPORT_PART_ITEMS_LIMIT (shared/constants) entries. */
  items: ImportPartItem[];
}

export interface ImportRecord {
  id: string;
  userId: string;
  source: ImportSource;
  kind: ImportKind;
  parts: ImportPart[];
  errors: string[];
  totalImported: number;
  totalNeedsAction: number;
  createdAt: Date;
}

export interface CreateImportRecordInput {
  source: ImportSource;
  kind: ImportKind;
  parts: ImportPart[];
  errors?: string[];
}

export interface ImportRecordListResult {
  records: ImportRecord[];
  /** Pass back as `cursor` to fetch the next (older) page; absent when exhausted. */
  nextCursor?: string;
}

/** Sources the server can scan on its own (their conversations/instructions/prompts live in the home dir). */
export type LocalImportServerSource = "claude-code" | "codex" | "gemini";

export interface LocalImportScanSource {
  source: ImportSource;
  /** The client's config directory exists on this machine. */
  available: boolean;
  parts: {
    conversations?: { count: number; handledBy: "server" };
    instructions?: { count: number; handledBy: "server"; path?: string };
    prompts?: { count: number; handledBy: "server" };
    /** MCP configs are discovered by the desktop (Rust) side; the server only flags the part. */
    mcp?: { handledBy: "desktop" };
    skills?: { handledBy: "desktop" };
  };
}

export interface LocalImportScanResult {
  homeDir: string;
  sources: LocalImportScanSource[];
}

/** One importable session, as listed by `GET /import/local/conversations`. */
export interface LocalImportConversationSummary {
  id: string;
  title: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  /** Already present in OpenHorn (same id). */
  alreadyImported: boolean;
}

export interface LocalImportConversationListResult {
  source: LocalImportServerSource;
  conversations: LocalImportConversationSummary[];
}

export interface LocalImportRunRequest {
  source: LocalImportServerSource;
  parts: {
    conversations?: { sessionIds: string[] | "all" };
    instructions?: true;
    prompts?: true;
  };
}

export interface LocalImportRunResult {
  recordId: string;
  parts: ImportPart[];
  errors: string[];
}

/** A slash-panel prompt template imported from `~/.codex/prompts` or `~/.claude/commands` (settings key `prompts.templates`). */
export interface PromptTemplate {
  id: string;
  name: string;
  namespace?: string;
  description?: string;
  argumentHint?: string;
  body: string;
  source: ImportSource;
  importedAt: number;
}
