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

export type ApiAgentRunPhase = "planning" | "execution";
export type ApiAgentTaskComplexity = "light" | "standard" | "deep";
export type ApiAgentTaskUxMode = "direct" | "compact" | "full";
export type ApiAgentRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type ApiAgentApprovalStatus = "pending" | "approved" | "rejected";
export type ApiAgentApprovalType = "plan_approval" | "tool_approval";
export type ApiAgentArtifactType =
  | "final_result"
  | "execution_summary"
  | "structured_result"
  | "source_bundle";
export type ApiAgentTaskEventType =
  | "task_status"
  | "plan_step"
  | "execution_event"
  | "approval_requested"
  | "approval_resolved"
  | "artifact_created"
  | "final_result"
  | "error"
  | "done";

export interface ApiAgentTaskAttachment {
  id?: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
}

export interface ApiAgentTaskInsight {
  highlight: "tool_approval" | "plan_approval" | "execution_failed" | "final_result" | null;
  summary: string | null;
  previewKind: "error" | "result" | "summary" | null;
  previewText: string | null;
  runCount: number;
  latestRunStatus: ApiAgentRunStatus | null;
  latestRunPhase: ApiAgentRunPhase | null;
  latestApprovalType: ApiAgentApprovalType | null;
  latestApprovalStatus: ApiAgentApprovalStatus | null;
  hasFinalResult: boolean;
}

export interface ApiAgentTask {
  id: string;
  userId: string;
  conversationId: string | null;
  channelId: string | null;
  modelId: string | null;
  title: string;
  goal: string;
  attachments: ApiAgentTaskAttachment[];
  complexity: ApiAgentTaskComplexity;
  uxMode: ApiAgentTaskUxMode;
  requiresPlanApproval: boolean;
  autoStart: boolean;
  status: ApiAgentTaskStatus;
  insight: ApiAgentTaskInsight | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentTaskRun {
  id: string;
  taskId: string;
  phase: ApiAgentRunPhase;
  status: ApiAgentRunStatus;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface ApiAgentApproval {
  id: string;
  taskId: string;
  runId: string;
  type: ApiAgentApprovalType;
  status: ApiAgentApprovalStatus;
  title: string;
  description: string | null;
  payload: unknown;
  response: unknown;
  requestedAt: string;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentArtifact {
  id: string;
  taskId: string;
  runId: string;
  type: ApiAgentArtifactType;
  title: string;
  content: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentTaskEvent {
  id: string;
  taskId: string;
  runId: string;
  type: ApiAgentTaskEventType;
  content: string | null;
  toolName: string | null;
  toolInput: unknown;
  metadata: unknown;
  createdAt: string;
}

export interface ApiAgentCheckResult {
  success: boolean;
  error?: string;
  errorCode?: ApiProviderErrorKind;
  retryable?: boolean;
  rawError?: string;
}

export interface ApiAgentTaskRuntime {
  channelId: string | null;
  channelName: string | null;
  modelId: string | null;
  source: "event" | "task";
}

export interface ApiAgentTaskDetail {
  task: ApiAgentTask;
  runs: ApiAgentTaskRun[];
  planSteps: ApiAgentPlanStep[];
  approvals: ApiAgentApproval[];
  artifacts: ApiAgentArtifact[];
  events: ApiAgentTaskEvent[];
  runtime?: ApiAgentTaskRuntime | null;
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

/**
 * Which runtime is actually executing an assistant message.
 *
 * - "server"  → OpenHorn server ran the task via /agent/tasks/*
 *               (the default) or via /messages/stream for chat mode
 * - "sidecar" → local sidecar process ran the task directly on the
 *               user's workspace. The server has no knowledge of
 *               this run, so task-card polling endpoints will not
 *               find it. Renderers that need to branch off this
 *               should check runtimeKind instead of sniffing the
 *               agentRun shape.
 */
export type AgentRuntimeKind = "server" | "sidecar";

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
  /**
   * Which runtime executed this assistant message. Absent (undefined)
   * is equivalent to "server" for backward compatibility with
   * messages persisted before the sidecar runtime existed.
   */
  runtimeKind?: AgentRuntimeKind;
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
