import type {
  ApiChannel,
  ApiConversation,
  ApiMessage,
  ApiSettingsMap,
  CreateConversationInput,
  SendMessageInput,
  UpdateConversationInput,
} from "../types/chat";

export const DEFAULT_DESKTOP_BACKEND_BASE = "http://localhost:3000";

type FetchLike = typeof fetch;

export interface ServerApi {
  conversations: {
    list: () => Promise<{ conversations: ApiConversation[] }>;
    create: (data: CreateConversationInput) => Promise<{ conversation: ApiConversation }>;
    update: (id: string, data: UpdateConversationInput) => Promise<{ success: boolean }>;
    delete: (id: string) => Promise<{ success: boolean }>;
  };
  messages: {
    list: (conversationId: string) => Promise<{ messages: ApiMessage[] }>;
    stream: (data: SendMessageInput, options?: { signal?: AbortSignal }) => Promise<Response>;
  };
  channels: {
    list: () => Promise<{ channels: ApiChannel[] }>;
  };
  settings: {
    get: (keys: string[]) => Promise<{ settings: ApiSettingsMap }>;
  };
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

export async function readErrorMessage(response: Response, fallback = "Request failed") {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const data = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof data.error === "string" && data.error.trim()) return data.error;
      if (typeof data.message === "string" && data.message.trim()) return data.message;
    } catch {
      return fallback;
    }
  }

  try {
    const text = await response.text();
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
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

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed"));
  }

  return (await response.json()) as T;
}

export function createServerApi(options?: { baseUrl?: string; fetch?: FetchLike }): ServerApi {
  const baseUrl = options?.baseUrl || getDesktopBackendBase();
  const fetchImpl = options?.fetch || fetch;

  return {
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
      stream: (data, options) =>
        fetchImpl(`${baseUrl}/messages/stream`, {
          method: "POST",
          credentials: "include",
          signal: options?.signal,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        }),
    },

    channels: {
      list: () => fetchJson(fetchImpl, baseUrl, "/channels"),
    },

    settings: {
      get: (keys) => {
        const query = encodeURIComponent((keys || []).join(","));
        return fetchJson(fetchImpl, baseUrl, `/settings?keys=${query}`);
      },
    },
  };
}
