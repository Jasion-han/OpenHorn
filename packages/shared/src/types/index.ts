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

export interface User {
  id: string;
  email: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}
