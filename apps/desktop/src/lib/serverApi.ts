import type {
  ApiAgentApprovalStatus,
  ApiChannel,
  ApiChannelModel,
  ApiConversation,
  ApiAgentTaskDetail,
  ApiMessage,
  ApiSettingsMap,
  CreateConversationInput,
  SendMessageInput,
  UpdateConversationInput,
} from "../types/chat";
import type { ApiUser, LoginInput, RegisterInput } from "../types/auth";

export const DEFAULT_DESKTOP_BACKEND_BASE = "http://localhost:3000";
export const UNAUTHORIZED_EVENT = "openhorn:unauthorized";

type FetchLike = typeof fetch;

export interface ServerApi {
  auth: {
    login: (data: LoginInput) => Promise<{ user: ApiUser }>;
    register: (data: RegisterInput) => Promise<{ user: ApiUser }>;
    logout: () => Promise<{ success: boolean }>;
    me: () => Promise<{ user: ApiUser | null }>;
  };
  conversations: {
    list: () => Promise<{ conversations: ApiConversation[] }>;
    create: (data: CreateConversationInput) => Promise<{ conversation: ApiConversation }>;
    update: (id: string, data: UpdateConversationInput) => Promise<{ success: boolean }>;
    delete: (id: string) => Promise<{ success: boolean }>;
  };
  messages: {
    list: (conversationId: string) => Promise<{ messages: ApiMessage[] }>;
    stream: (data: SendMessageInput, options?: { signal?: AbortSignal }) => Promise<Response>;
    delete: (id: string) => Promise<{ success: boolean }>;
    regenerate: (
      id: string,
      data?: { userMessageId?: string; userContent?: string },
      options?: { signal?: AbortSignal },
    ) => Promise<Response>;
    edit: (id: string, content: string, options?: { signal?: AbortSignal }) => Promise<Response>;
  };
  channels: {
    list: () => Promise<{ channels: ApiChannel[] }>;
    get: (id: string) => Promise<{ channel: ApiChannel }>;
    create: (data: {
      name: string;
      provider: string;
      apiKey: string;
      baseUrl?: string;
      enabled?: boolean;
      isDefault?: boolean;
    }) => Promise<{ channel: ApiChannel }>;
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
    ) => Promise<{ channel: ApiChannel }>;
    delete: (id: string) => Promise<{ success: boolean }>;
    test: (id: string) => Promise<{ success: boolean; error?: string }>;
    fetchModels: (
      id: string,
    ) => Promise<{ success: boolean; error?: string; models: ApiChannelModel[] }>;
    listModels: (id: string) => Promise<{ models: ApiChannelModel[] }>;
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
    ) => Promise<{ models: ApiChannelModel[] }>;
    setDefault: (id: string) => Promise<{ success: boolean }>;
    setDefaultModel: (id: string, modelId: string) => Promise<{ success: boolean }>;
    agentCheck: (id: string, data: { modelId: string }) => Promise<{ success: boolean; error?: string }>;
  };
  settings: {
    get: (keys: string[]) => Promise<{ settings: ApiSettingsMap }>;
  };
  agentTasks: {
    get: (id: string) => Promise<ApiAgentTaskDetail>;
    plan: (id: string) => Promise<ApiAgentTaskDetail>;
    execute: (id: string, options?: { signal?: AbortSignal }) => Promise<Response>;
    retry: (id: string, options?: { signal?: AbortSignal }) => Promise<Response>;
    continue: (id: string, options?: { signal?: AbortSignal }) => Promise<Response>;
    cancel: (id: string) => Promise<ApiAgentTaskDetail>;
    respondApproval: (
      id: string,
      data: {
        status: Exclude<ApiAgentApprovalStatus, "pending">;
        response?: unknown;
      },
    ) => Promise<ApiAgentTaskDetail>;
  };
}

function emitUnauthorized() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

function getEnvBase() {
  return (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE;
}

export function getDesktopBackendBase(): string {
  const envBase = getEnvBase();
  if (typeof envBase === "string" && envBase.trim()) {
    return envBase.trim();
  }

  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:3000";
  }

  return DEFAULT_DESKTOP_BACKEND_BASE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeQuotedJsonString(value: string) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function extractErrorMessage(error: unknown, fallback = "Request failed"): string {
  if (typeof error === "string") {
    const normalized = error.trim();
    if (!normalized) return fallback;

    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      try {
        return extractErrorMessage(JSON.parse(normalized), fallback);
      } catch {
        return extractErrorMessage(normalized.slice(1, -1), fallback);
      }
    }

    if (normalized.startsWith("{") || normalized.startsWith("[")) {
      try {
        return extractErrorMessage(JSON.parse(normalized), fallback);
      } catch {
        const nestedMessageMatch = normalized.match(/"message"\s*:\s*"((?:\\.|[^"])*)"/);
        if (nestedMessageMatch?.[1]) {
          return decodeQuotedJsonString(nestedMessageMatch[1]).trim() || fallback;
        }

        const nestedErrorMatch = normalized.match(/"error"\s*:\s*"((?:\\.|[^"])*)"/);
        if (nestedErrorMatch?.[1]) {
          return extractErrorMessage(decodeQuotedJsonString(nestedErrorMatch[1]), fallback);
        }

        return normalized;
      }
    }

    return normalized;
  }

  if (error instanceof Error) {
    return extractErrorMessage(error.message, fallback);
  }

  if (Array.isArray(error)) {
    const messages = error
      .map((item) => extractErrorMessage(item, ""))
      .filter((item) => item.trim().length > 0);
    return messages[0] || fallback;
  }

  if (isRecord(error)) {
    if ("error" in error) return extractErrorMessage(error.error, fallback);
    if ("message" in error) return extractErrorMessage(error.message, fallback);
    if ("detail" in error) return extractErrorMessage(error.detail, fallback);
  }

  return fallback;
}

export async function readErrorMessage(response: Response, fallback = "Request failed") {
  const rawText = await response.text().catch(() => "");
  return extractErrorMessage(rawText, fallback);
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    emitUnauthorized();
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed"));
  }

  return (await response.json()) as T;
}

export function createServerApi(options?: { baseUrl?: string; fetch?: FetchLike }): ServerApi {
  const baseUrl = options?.baseUrl || getDesktopBackendBase();
  const fetchImpl = options?.fetch || fetch;

  return {
    auth: {
      login: (data) =>
        fetchJson(fetchImpl, baseUrl, "/auth/login", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      register: (data) =>
        fetchJson(fetchImpl, baseUrl, "/auth/register", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      logout: () =>
        fetchJson(fetchImpl, baseUrl, "/auth/logout", {
          method: "POST",
        }),
      me: () => fetchJson(fetchImpl, baseUrl, "/auth/me"),
    },

    conversations: {
      list: () => fetchJson(fetchImpl, baseUrl, "/conversations"),
      create: (data) =>
        fetchJson(fetchImpl, baseUrl, "/conversations", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      update: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/conversations/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(data),
        }),
      delete: (id) =>
        fetchJson(fetchImpl, baseUrl, `/conversations/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },

    messages: {
      list: (conversationId) =>
        fetchJson(fetchImpl, baseUrl, `/messages/${encodeURIComponent(conversationId)}`),
      stream: async (data, options) => {
        const response = await fetchImpl(`${baseUrl}/messages/stream`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        });

        if (response.status === 401) {
          emitUnauthorized();
        }

        return response;
      },
      delete: (id) =>
        fetchJson(fetchImpl, baseUrl, `/messages/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      regenerate: async (id, data, options) => {
        const response = await fetchImpl(
          `${baseUrl}/messages/${encodeURIComponent(id)}/regenerate`,
          {
            method: "POST",
            credentials: "include",
            signal: options?.signal,
            headers: {
              "Content-Type": "application/json",
            },
            body: data ? JSON.stringify(data) : undefined,
          },
        );

        if (response.status === 401) {
          emitUnauthorized();
        }

        return response;
      },
      edit: async (id, content, options) => {
        const response = await fetchImpl(`${baseUrl}/messages/${encodeURIComponent(id)}/edit`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content }),
        });

        if (response.status === 401) {
          emitUnauthorized();
        }

        return response;
      },
    },

    channels: {
      list: () => fetchJson(fetchImpl, baseUrl, "/channels"),
      get: (id) => fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}`),
      create: (data) =>
        fetchJson(fetchImpl, baseUrl, "/channels", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      update: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(data),
        }),
      delete: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      test: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/test`, {
          method: "POST",
        }),
      fetchModels: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/fetch-models`, {
          method: "POST",
        }),
      listModels: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/models`),
      updateModels: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/models`, {
          method: "PUT",
          body: JSON.stringify(data),
        }),
      setDefault: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/set-default`, {
          method: "POST",
        }),
      setDefaultModel: (id, modelId) =>
        fetchJson(
          fetchImpl,
          baseUrl,
          `/channels/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/set-default`,
          {
            method: "POST",
          },
        ),
      agentCheck: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/agent-check`, {
          method: "POST",
          body: JSON.stringify(data),
        }),
    },

    settings: {
      get: (keys) => {
        const query = encodeURIComponent((keys || []).join(","));
        return fetchJson(fetchImpl, baseUrl, `/settings?keys=${query}`);
      },
    },

    agentTasks: {
      get: (id) => fetchJson(fetchImpl, baseUrl, `/agent/tasks/${encodeURIComponent(id)}`),
      plan: (id) =>
        fetchJson(fetchImpl, baseUrl, `/agent/tasks/${encodeURIComponent(id)}/plan`, {
          method: "POST",
        }),
      execute: (id, options) =>
        fetchImpl(`${baseUrl}/agent/tasks/${encodeURIComponent(id)}/execute`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
        }),
      retry: (id, options) =>
        fetchImpl(`${baseUrl}/agent/tasks/${encodeURIComponent(id)}/retry`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
        }),
      continue: (id, options) =>
        fetchImpl(`${baseUrl}/agent/tasks/${encodeURIComponent(id)}/continue`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
        }),
      cancel: (id) =>
        fetchJson(fetchImpl, baseUrl, `/agent/tasks/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
        }),
      respondApproval: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/agent/approvals/${encodeURIComponent(id)}/respond`, {
          method: "POST",
          body: JSON.stringify(data),
        }),
    },
  };
}
