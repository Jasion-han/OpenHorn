import { useAuthStore } from "../stores/authStore";
import { useBackendStatusStore } from "../stores/backendStatusStore";
import { useChatStore } from "../stores/chatStore";
import { getBackendBase } from "./backendBase";
import { notifyErrorOnce } from "./notify";

export const API_BASE = getBackendBase();

const UNAUTHORIZED_EVENT = "openhorn:unauthorized";

export interface ApiUser {
  id: string;
  email: string;
  username: string;
}

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
  defaultMode: "chat" | "agent" | null;
  lastMode: "chat" | "agent" | null;
  isPinned: boolean;
  forceWebSearch?: boolean | null;
  runStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAgentRunStep {
  type: "tool_start" | "tool_result" | "error";
  toolName?: string;
  content?: string;
  toolInput?: unknown;
}

export interface ApiAgentRun {
  status: "completed" | "failed" | "cancelled" | "partial";
  summary: string;
  error?: string;
  steps: ApiAgentRunStep[];
  legacySessionId?: string;
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

export interface ApiSearchStatus {
  configured: boolean;
  source: "user" | "server" | "none" | "disabled";
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  mode: "chat" | "agent" | null;
  attachments: string | null;
  agentRun: string | null;
  liveMetadata: string | null;
  citations: string | null;
  attachmentsMeta?: Array<{
    id: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  }>;
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
export type ApiAgentRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type ApiAgentApprovalStatus = "pending" | "approved" | "rejected";
export type ApiAgentApprovalType = "plan_approval" | "tool_approval";
export type ApiAgentTaskInsightHighlight =
  | "tool_approval"
  | "plan_approval"
  | "execution_failed"
  | "final_result";
export type ApiAgentTaskInsightPreviewKind = "error" | "result" | "summary";
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
  highlight: ApiAgentTaskInsightHighlight | null;
  summary: string | null;
  previewKind: ApiAgentTaskInsightPreviewKind | null;
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

export interface ApiAgentTaskDetail {
  task: ApiAgentTask;
  runs: ApiAgentTaskRun[];
  planSteps: ApiAgentPlanStep[];
  approvals: ApiAgentApproval[];
  artifacts: ApiAgentArtifact[];
  events: ApiAgentTaskEvent[];
}

export type ApiSettingsMap = Record<string, string>;

async function probeReachableButBlocked(url: string): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    // `no-cors` returns an opaque response when reachable, but does not validate CORS.
    // If this succeeds while a normal request fails, it's often CORS/mixed-content/browser blocking.
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch";
    // Backend is likely down/unreachable. Mark global status + dedupe the toast.
    useBackendStatusStore.getState().markDown(message);
    const origin = typeof window === "undefined" ? null : window.location.origin;
    const isMixedContent =
      typeof window !== "undefined" &&
      window.location.protocol === "https:" &&
      API_BASE.startsWith("http:");

    let description = `无法连接到后端服务（${API_BASE}）。请确认 server 已启动后点击「重试」。`;
    if (isMixedContent) {
      description = `无法连接到后端服务（${API_BASE}）。当前页面为 HTTPS，但后端为 HTTP，浏览器可能会拦截（Mixed Content）。请改用 HTTP 打开前端或为后端配置 HTTPS。`;
    } else if (await probeReachableButBlocked(`${API_BASE}/`)) {
      description = `无法请求后端服务（${API_BASE}），但探测到服务可能已启动。更可能是浏览器拦截（CORS/跨域）。请检查后端是否允许 Origin：${origin || "unknown"}，并查看 DevTools Console/Network 的 CORS 报错。`;
    }
    notifyErrorOnce("backend_down", "后端不可用", description);
    throw error;
  }

  // We got an HTTP response: backend is reachable (even if it's 401/500).
  useBackendStatusStore.getState().markUp();

  if (response.status === 401) {
    notifyErrorOnce("unauthorized", "登录已失效", "登录状态已失效，请重新登录。");
    // Best-effort: clear client auth state so UI doesn't look "logged in but broken".
    try {
      useAuthStore.getState().logout();
      useChatStore.getState().setChannels([]);
    } catch {
      // ignore
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return response.json();
}

export const api = {
  auth: {
    register: (data: { email: string; username: string; password: string }) =>
      fetchApi<{ user: ApiUser }>("/auth/register", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    login: (data: { email: string; password: string }) =>
      fetchApi<{ user: ApiUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    logout: () =>
      fetchApi<{ success: boolean }>("/auth/logout", {
        method: "POST",
      }),

    me: () => fetchApi<{ user: ApiUser | null }>("/auth/me"),
  },

  channels: {
    list: () => fetchApi<{ channels: ApiChannel[] }>("/channels"),

    get: (id: string) => fetchApi<{ channel: ApiChannel }>(`/channels/${id}`),

    create: (data: {
      name: string;
      provider: string;
      apiKey: string;
      baseUrl?: string;
      enabled?: boolean;
      isDefault?: boolean;
    }) =>
      fetchApi<{ channel: ApiChannel }>("/channels", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    update: (
      id: string,
      data: {
        name?: string;
        provider?: string;
        apiKey?: string;
        baseUrl?: string;
        enabled?: boolean;
        isDefault?: boolean;
      },
    ) =>
      fetchApi<{ channel: ApiChannel }>(`/channels/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),

    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/channels/${id}`, {
        method: "DELETE",
      }),

    test: (id: string) =>
      fetchApi<{ success: boolean; error?: string }>(`/channels/${id}/test`, {
        method: "POST",
      }),

    fetchModels: (id: string) =>
      fetchApi<{ success: boolean; error?: string; models: ApiChannelModel[] }>(
        `/channels/${id}/fetch-models`,
        {
          method: "POST",
        },
      ),

    listModels: (id: string) => fetchApi<{ models: ApiChannelModel[] }>(`/channels/${id}/models`),

    updateModels: (
      id: string,
      data: {
        models: Array<{
          modelId: string;
          displayName?: string;
          enabled?: boolean;
          isDefault?: boolean;
        }>;
      },
    ) =>
      fetchApi<{ models: ApiChannelModel[] }>(`/channels/${id}/models`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),

    setDefault: (id: string) =>
      fetchApi<{ success: boolean }>(`/channels/${id}/set-default`, {
        method: "POST",
      }),

    setDefaultModel: (id: string, modelId: string) =>
      fetchApi<{ success: boolean }>(
        `/channels/${id}/models/${encodeURIComponent(modelId)}/set-default`,
        {
          method: "POST",
        },
      ),

    agentCheck: (id: string, data: { modelId: string }) =>
      fetchApi<{ success: boolean; error?: string }>(`/channels/${id}/agent-check`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },

  conversations: {
    list: () => fetchApi<{ conversations: ApiConversation[] }>("/conversations"),

    get: (id: string) => fetchApi<{ conversation: ApiConversation }>(`/conversations/${id}`),

    create: (data: { title: string; channelId?: string | null; modelId?: string | null }) =>
      fetchApi<{ conversation: ApiConversation }>("/conversations", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    update: (
      id: string,
      data: {
        title?: string;
        channelId?: string | null;
        modelId?: string | null;
        systemPrompt?: string;
        contextLength?: number;
        isPinned?: boolean;
        forceWebSearch?: boolean;
      },
    ) =>
      fetchApi<{ success: boolean }>(`/conversations/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),

    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/conversations/${id}`, {
        method: "DELETE",
      }),

    autoTitle: (id: string, prompt: string) =>
      fetchApi<{ success: boolean; title?: string }>(`/conversations/${id}/auto-title`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
  },

  messages: {
    list: (conversationId: string) =>
      fetchApi<{ messages: ApiMessage[] }>(`/messages/${conversationId}`),

    send: (data: { conversationId: string; content: string; attachments?: string[] }) =>
      fetchApi<{ userMessage: ApiMessage; assistantMessage: ApiMessage }>("/messages", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    stream: (
      data: {
        conversationId: string;
        content: string;
        attachments?: string[];
        mode?: "chat" | "agent";
      },
      options?: { signal?: AbortSignal },
    ) => {
      return fetch(`${API_BASE}/messages/stream`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    },

    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/messages/${id}`, {
        method: "DELETE",
      }),

    regenerate: (
      id: string,
      data?: { userMessageId?: string; userContent?: string },
      options?: { signal?: AbortSignal },
    ) => {
      return fetch(`${API_BASE}/messages/${id}/regenerate`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
        headers: { "Content-Type": "application/json" },
        body: data ? JSON.stringify(data) : undefined,
      });
    },

    edit: (id: string, content: string, options?: { signal?: AbortSignal }) => {
      return fetch(`${API_BASE}/messages/${id}/edit`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    },
  },

  agent: {
    listSessions: () => fetchApi<{ sessions: unknown[] }>("/agent/sessions"),

    getSession: (id: string) => fetchApi<{ session: unknown }>(`/agent/sessions/${id}`),

    createSession: (data: { title: string; channelId?: string }) =>
      fetchApi<{ session: unknown }>("/agent/sessions", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    renameSession: (id: string, title: string) =>
      fetchApi<{ success: boolean }>(`/agent/sessions/${id}`, {
        method: "PUT",
        body: JSON.stringify({ title }),
      }),

    autoTitle: (id: string, prompt: string) =>
      fetchApi<{ success: boolean; title?: string }>(`/agent/sessions/${id}/auto-title`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),

    runSession: (
      sessionId: string,
      prompt: string,
      attachments?: string[],
      options?: { signal?: AbortSignal },
    ) => {
      return fetch(`${API_BASE}/agent/sessions/${sessionId}/run`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, attachments }),
      });
    },

    updateStatus: (id: string, status: string) =>
      fetchApi<{ success: boolean }>(`/agent/sessions/${id}/status`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      }),

    deleteSession: (id: string) =>
      fetchApi<{ success: boolean }>(`/agent/sessions/${id}`, {
        method: "DELETE",
      }),

    listEvents: (sessionId: string) =>
      fetchApi<{
        events: Array<{
          id?: string;
          type: string;
          content?: string;
          toolName?: string;
          toolInput?: unknown;
        }>;
      }>(`/agent/sessions/${sessionId}/events`),

    deleteEvent: (eventId: string) =>
      fetchApi<{ success: boolean }>(`/agent/events/${eventId}`, { method: "DELETE" }),

    updateChannel: (sessionId: string, channelId: string, modelId: string) =>
      fetchApi<{ success: boolean }>(`/agent/sessions/${sessionId}/channel`, {
        method: "PUT",
        body: JSON.stringify({ channelId, modelId }),
      }),
  },

  agentTasks: {
    list: () => fetchApi<{ tasks: ApiAgentTask[] }>("/agent/tasks"),

    get: (id: string) => fetchApi<ApiAgentTaskDetail>(`/agent/tasks/${id}`),

    create: (data: {
      title?: string;
      goal: string;
      conversationId?: string | null;
      channelId?: string | null;
      modelId?: string | null;
      attachments?: ApiAgentTaskAttachment[];
    }) =>
      fetchApi<{ task: ApiAgentTask }>("/agent/tasks", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    update: (id: string, data: { title?: string; goal: string }) =>
      fetchApi<ApiAgentTaskDetail>(`/agent/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),

    plan: (id: string) =>
      fetchApi<ApiAgentTaskDetail>(`/agent/tasks/${id}/plan`, {
        method: "POST",
      }),

    execute: (id: string, options?: { signal?: AbortSignal }) =>
      fetch(`${API_BASE}/agent/tasks/${id}/execute`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
      }),

    retry: (id: string, options?: { signal?: AbortSignal }) =>
      fetch(`${API_BASE}/agent/tasks/${id}/retry`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
      }),

    continue: (id: string, options?: { signal?: AbortSignal }) =>
      fetch(`${API_BASE}/agent/tasks/${id}/continue`, {
        method: "POST",
        credentials: "include",
        signal: options?.signal,
      }),

    cancel: (id: string) =>
      fetchApi<ApiAgentTaskDetail>(`/agent/tasks/${id}/cancel`, {
        method: "POST",
      }),

    listEvents: (id: string) =>
      fetchApi<{ events: ApiAgentTaskEvent[] }>(`/agent/tasks/${id}/events`),

    listArtifacts: (id: string) =>
      fetchApi<{ artifacts: ApiAgentArtifact[] }>(`/agent/tasks/${id}/artifacts`),

    respondApproval: (
      id: string,
      data: {
        status: Exclude<ApiAgentApprovalStatus, "pending">;
        response?: unknown;
      },
    ) =>
      fetchApi<ApiAgentTaskDetail>(`/agent/approvals/${id}/respond`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },

  mcp: {
    listServers: () => fetchApi<{ servers: unknown[] }>("/mcp/servers"),

    createServer: (data: { name: string; type: string; config: Record<string, unknown> }) =>
      fetchApi<{ server: unknown }>("/mcp/servers", {
        method: "POST",
        body: JSON.stringify(data),
      }),

    updateServer: (
      id: string,
      data: { name?: string; config?: Record<string, unknown>; isEnabled?: boolean },
    ) =>
      fetchApi<{ success: boolean }>(`/mcp/servers/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),

    deleteServer: (id: string) =>
      fetchApi<{ success: boolean }>(`/mcp/servers/${id}`, {
        method: "DELETE",
      }),

    testServer: (id: string) =>
      fetchApi<{ success: boolean; error?: string }>(`/mcp/servers/${id}/test`, {
        method: "POST",
      }),
  },

  settings: {
    get: (keys: string[]) => {
      const query = encodeURIComponent((keys || []).join(","));
      return fetchApi<{ settings: ApiSettingsMap }>(`/settings?keys=${query}`);
    },

    set: (key: string, value: string | null) =>
      fetchApi<{ success: boolean }>(`/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),

    searchStatus: () => fetchApi<ApiSearchStatus>("/settings/search-status"),
  },
};
