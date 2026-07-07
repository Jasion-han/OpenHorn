export type ChannelProtocol = "openai" | "anthropic" | "google";
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

export interface ProviderPreset {
  protocol: ChannelProtocol;
  baseUrl: string;
  name: string;
}
