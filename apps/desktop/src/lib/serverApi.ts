import { useBackendStatusStore } from "../stores/backendStatusStore";
import type { ApiUser, LoginInput, RegisterInput } from "../types/auth";
import type {
  ApiAgentCheckResult,
  ApiChannel,
  ApiChannelModel,
  ApiConversation,
  ApiMessage,
  ApiSettingsMap,
  CreateConversationInput,
  SendMessageInput,
  UpdateConversationInput,
} from "../types/chat";
import { getDesktopBackendBase } from "./backendBase";

export const UNAUTHORIZED_EVENT = "openhorn:unauthorized";

type FetchLike = typeof fetch;

export interface ChatPrepareResult {
  apiKey: string;
  baseUrl: string | null;
  protocol: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  userMessageId: string;
  assistantMessageId: string;
}

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
    autoTitle: (id: string, prompt: string) => Promise<{ success: boolean; title?: string }>;
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
    syncSidecar: (data: {
      conversationId: string;
      userContent: string;
      assistantContent: string;
      model?: string;
      agentRun?: unknown;
      // Local-run attachments never reach the server as files; this metadata is
      // stored so the user's bubble keeps its attachment chips across reloads.
      attachmentsMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
      // When both are provided, the existing round is updated in place instead of
      // inserting a new pair (edit-and-resend), preventing duplicate rounds.
      userMessageId?: string;
      assistantMessageId?: string;
    }) => Promise<{ userMessageId: string; assistantMessageId: string }>;
    chatPrepare: (data: {
      conversationId: string;
      content: string;
      attachments?: string[];
    }) => Promise<ChatPrepareResult>;
    chatComplete: (data: {
      assistantMessageId: string;
      conversationId: string;
      content: string;
      model?: string;
    }) => Promise<{ success: boolean }>;
  };
  channels: {
    list: () => Promise<{ channels: ApiChannel[] }>;
    get: (id: string) => Promise<{ channel: ApiChannel }>;
    create: (data: {
      name: string;
      provider: string;
      protocol?: "openai" | "anthropic" | "google";
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
        protocol?: "openai" | "anthropic" | "google";
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
    agentCheck: (id: string, data: { modelId: string }) => Promise<ApiAgentCheckResult>;
    /**
     * Fetches the decrypted credentials for a channel the current user
     * owns. Used by the sidecar runtime bootstrapping path to hand the
     * apiKey to the local Claude Agent SDK.
     */
    getCredentials: (id: string) => Promise<{
      credentials: {
        apiKey: string;
        baseUrl: string | null;
        modelId: string;
        protocol: "openai" | "anthropic" | "google";
        isCliOAuth?: boolean;
      };
    }>;
  };
  settings: {
    get: (keys: string[]) => Promise<{ settings: ApiSettingsMap }>;
    set: (key: string, value: string | null) => Promise<{ success: boolean }>;
  };
  mcp: {
    listServers: () => Promise<{ servers: unknown[] }>;
    createServer: (data: {
      name: string;
      type: string;
      config: Record<string, unknown>;
    }) => Promise<{ server: unknown }>;
    updateServer: (
      id: string,
      data: {
        name?: string;
        type?: string;
        config?: Record<string, unknown>;
        isEnabled?: boolean;
      },
    ) => Promise<{ success: boolean }>;
    deleteServer: (id: string) => Promise<{ success: boolean }>;
    testServer: (id: string) => Promise<{ success: boolean; error?: string }>;
  };
}

function emitUnauthorized() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
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

async function requestWithBackendStatus(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    useBackendStatusStore.getState().markUp();
    if (response.status === 401) {
      emitUnauthorized();
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch";
    useBackendStatusStore.getState().markDown(message);
    throw error;
  }
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await requestWithBackendStatus(fetchImpl, `${baseUrl}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

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
      autoTitle: (id, prompt) =>
        fetchJson(fetchImpl, baseUrl, `/conversations/${encodeURIComponent(id)}/auto-title`, {
          method: "POST",
          body: JSON.stringify({ prompt }),
        }),
    },

    messages: {
      list: (conversationId) =>
        fetchJson(fetchImpl, baseUrl, `/messages/${encodeURIComponent(conversationId)}`),
      stream: async (data, options) => {
        return requestWithBackendStatus(fetchImpl, `${baseUrl}/messages/stream`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        });
      },
      delete: (id) =>
        fetchJson(fetchImpl, baseUrl, `/messages/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      regenerate: async (id, data, options) => {
        return requestWithBackendStatus(
          fetchImpl,
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
      },
      edit: async (id, content, options) => {
        return requestWithBackendStatus(
          fetchImpl,
          `${baseUrl}/messages/${encodeURIComponent(id)}/edit`,
          {
            method: "POST",
            credentials: "include",
            signal: options?.signal,
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ content }),
          },
        );
      },
      syncSidecar: (data) =>
        fetchJson(fetchImpl, baseUrl, "/messages/sync-sidecar", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      chatPrepare: (data) =>
        fetchJson(fetchImpl, baseUrl, "/messages/chat/prepare", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      chatComplete: (data) =>
        fetchJson(fetchImpl, baseUrl, "/messages/chat/complete", {
          method: "POST",
          body: JSON.stringify(data),
        }),
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
      getCredentials: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/credentials`),
    },

    settings: {
      get: (keys) => {
        const query = encodeURIComponent((keys || []).join(","));
        return fetchJson(fetchImpl, baseUrl, `/settings?keys=${query}`);
      },
      set: (key, value) =>
        fetchJson(fetchImpl, baseUrl, `/settings/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        }),
    },

    mcp: {
      listServers: () => fetchJson(fetchImpl, baseUrl, "/mcp/servers"),
      createServer: (data) =>
        fetchJson(fetchImpl, baseUrl, "/mcp/servers", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      updateServer: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/mcp/servers/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(data),
        }),
      deleteServer: (id) =>
        fetchJson(fetchImpl, baseUrl, `/mcp/servers/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      testServer: (id) =>
        fetchJson(fetchImpl, baseUrl, `/mcp/servers/${encodeURIComponent(id)}/test`, {
          method: "POST",
        }),
    },
  };
}
