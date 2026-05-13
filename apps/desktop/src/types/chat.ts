export type ChatMode = "chat" | "agent";

export type ApiProviderErrorKind =
  | "quota_exhausted"
  | "ssl_handshake_failed"
  | "gateway_failed"
  | "auth_failed"
  | "timeout"
  | "protocol_incompatible"
  | "model_not_found"
  | "request_failed"
  | "server_failed"
  | "network_failed"
  | "unknown";

export interface ApiChannelModel {
  id: string;
  channelId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiChannel {
  id: string;
  userId: string;
  name: string;
  provider: string;
  protocol: "openai" | "anthropic" | "google";
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  models: ApiChannelModel[];
  defaultModelId: string | null;
  legacyModel: string | null;
  hasApiKey: boolean;
}

export interface ApiConversation {
  id: string;
  userId: string;
  title: string;
  channelId: string | null;
  modelId: string | null;
  systemPrompt: string | null;
  contextLength: number;
  defaultMode: ChatMode | null;
  lastMode: ChatMode | null;
  isPinned: boolean;
  forceWebSearch?: boolean | null;
  runStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentRunStep {
  type: "tool_start" | "tool_result" | "error" | "text";
  toolName?: string;
  content?: string;
  toolInput?: unknown;
}

export interface ApiAgentRun {
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "partial";
  summary: string;
  error?: string;
  steps: ApiAgentRunStep[];
  toolCount?: number;
  legacySessionId?: string;
  taskId?: string;
  complexity?: "light" | "standard" | "deep";
  uxMode?: "direct" | "compact" | "full";
  requiresPlanApproval?: boolean;
  autoStart?: boolean;
  taskStatus?:
    | "draft"
    | "planning"
    | "awaiting_approval"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  latestRunId?: string | null;
  latestRunPhase?: "planning" | "execution" | null;
  latestApprovalId?: string | null;
  latestApprovalType?: "plan_approval" | "tool_approval" | null;
  latestApprovalStatus?: "pending" | "approved" | "rejected" | null;
}

export type ApiLiveStatus = "live" | "offline";
export type ApiLiveRoute = "local" | "structured_live" | "web_search" | "research" | "direct_model";

export interface ApiLiveMetadata {
  status: ApiLiveStatus;
  route: ApiLiveRoute;
  label?: string;
  sourceType: "local" | "weather" | "web_search" | "none";
}

export interface ApiCitation {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface ApiMessageAttachmentMeta {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  previewUrl?: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  mode: ChatMode | null;
  attachments: string | null;
  agentRun: string | null;
  liveMetadata: string | null;
  citations: string | null;
  attachmentsMeta?: ApiMessageAttachmentMeta[];
  createdAt: string;
}

export type ApiAgentTaskStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ApiAgentPlanStep {
  id: string;
  taskId: string;
  runId: string;
  orderIndex: number;
  title: string;
  description: string | null;
  status: "pending" | "ready" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentCheckResult {
  success: boolean;
  error?: string;
  errorCode?: ApiProviderErrorKind;
  retryable?: boolean;
  rawError?: string;
}

export type ApiSettingsMap = Record<string, string>;

export interface ChannelModel {
  id: string;
  channelId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Channel {
  id: string;
  userId: string;
  name: string;
  provider: string;
  protocol: "openai" | "anthropic" | "google";
  baseUrl?: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  models: ChannelModel[];
  defaultModelId?: string;
  legacyModel?: string;
  hasApiKey: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  channelId?: string;
  modelId?: string;
  systemPrompt?: string;
  contextLength: number;
  defaultMode: ChatMode;
  lastMode: ChatMode;
  isPinned: boolean;
  forceWebSearch?: boolean;
  runStatus?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageAttachmentMeta {
  id?: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
  previewUrl?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  mode: ChatMode;
  attachments?: string[];
  agentRun?: ApiAgentRun;
  attachmentsMeta?: MessageAttachmentMeta[];
  liveStatus?: ApiLiveStatus;
  liveRoute?: ApiLiveRoute;
  liveLabel?: string;
  citations?: ApiCitation[];
  streamTail?: string;
  streamPulseKey?: number;
  createdAt: Date;
}

export type ChatStreamEvent =
  | { type: "live_status"; status: ApiLiveStatus; route: ApiLiveRoute; label?: string }
  | { type: "citations"; citations: ApiCitation[] }
  | { type: "delta"; content: string }
  | { type: "done"; messageId?: string; model?: string; agentRun?: ApiAgentRun }
  | {
      type: "agent_event";
      event: { type: string; content?: string; toolName?: string; toolInput?: unknown };
    }
  | { type: "error"; message: string };

export interface CreateConversationInput {
  title: string;
  channelId?: string | null;
  modelId?: string | null;
}

export interface UpdateConversationInput {
  title?: string;
  channelId?: string | null;
  modelId?: string | null;
  systemPrompt?: string;
  contextLength?: number;
  isPinned?: boolean;
  forceWebSearch?: boolean;
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
  mode?: ChatMode;
}
