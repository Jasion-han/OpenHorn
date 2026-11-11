import { PROMPT_TEMPLATES_SETTING_KEY } from "shared/constants";
import type {
  CreateImportRecordInput,
  LocalImportConversationListResult,
  LocalImportRunRequest,
  LocalImportRunResult,
  LocalImportScanResult,
  LocalImportServerSource,
  MessageFinishReason,
  ModelContextMetadata,
  PromptTemplate,
} from "shared/types";
import { useBackendStatusStore } from "../stores/backendStatusStore";
import type {
  ApiAgentCheckResult,
  ApiChannel,
  ApiChannelModel,
  ApiConversation,
  ApiImportRecord,
  ApiImportRecordListResult,
  ApiMessage,
  ApiProject,
  ApiSettingsMap,
  CreateConversationInput,
  ExportBackupResult,
  ExportEstimate,
  ImportResult,
  MessageSearchResult,
  SendMessageInput,
  UpdateConversationInput,
} from "../types/chat";
import { getDesktopBackendBase } from "./backendBase";
import { BackupSizeLimitError } from "./dataTransferError";

export class ChatPreparationFailure extends Error {
  constructor(
    message: string,
    readonly userMessageId: string,
    readonly assistantMessageId: string,
    readonly code: "chat_context_budget_exceeded" | "chat_preparation_failed",
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = "openhorn:unauthorized";

type FetchLike = typeof fetch;

export interface ChatPrepareResult {
  apiKey: string;
  baseUrl: string | null;
  protocol: string;
  model: string;
  contextWindow?: number | null;
  contextMetadata?: ModelContextMetadata | null;
  messages: Array<{ role: string; content: unknown }>;
  userMessageId: string;
  assistantMessageId: string;
}

export interface ServerApi {
  conversations: {
    list: () => Promise<{ conversations: ApiConversation[] }>;
    create: (data: CreateConversationInput) => Promise<{ conversation: ApiConversation }>;
    update: (id: string, data: UpdateConversationInput) => Promise<{ success: boolean }>;
    delete: (id: string) => Promise<{ success: boolean }>;
    autoTitle: (id: string, prompt: string) => Promise<{ success: boolean; title?: string }>;
  };
  projects: {
    list: () => Promise<{ projects: ApiProject[] }>;
    create: (data: { name: string; rootPath: string }) => Promise<{ project: ApiProject }>;
    update: (
      id: string,
      data: { name?: string; isStarred?: boolean },
    ) => Promise<{ project: ApiProject }>;
    delete: (id: string) => Promise<{ success: boolean }>;
  };
  messages: {
    list: (conversationId: string) => Promise<{ messages: ApiMessage[] }>;
    search: (query: string) => Promise<{ results: MessageSearchResult[] }>;
    stream: (data: SendMessageInput, options?: { signal?: AbortSignal }) => Promise<Response>;
    delete: (id: string) => Promise<{ success: boolean }>;
    regenerate: (
      id: string,
      data?: { userMessageId?: string; userContent?: string; appendSystemPrompt?: string },
      options?: { signal?: AbortSignal },
    ) => Promise<Response>;
    edit: (
      id: string,
      content: string,
      options?: { signal?: AbortSignal; appendSystemPrompt?: string },
    ) => Promise<Response>;
    syncSidecar: (data: {
      conversationId: string;
      userContent: string;
      assistantContent: string;
      model?: string;
      agentRun?: unknown;
      /** Token counts for the turn. Absent when the runtime did not report them. */
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      /** "stopped" when the user stopped the run (the server also derives it from a cancelled run). */
      finishReason?: MessageFinishReason;
      // Local-run attachments never reach the server as files; this metadata is
      // stored so the user's bubble keeps its attachment chips across reloads.
      attachmentsMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
      // A complete stable pair updates existing rows or creates both atomically.
      // Retrying the same IDs cannot duplicate the round. With only an existing
      // userMessageId, the user is updated and its reply is inserted.
      userMessageId?: string;
      assistantMessageId?: string;
      /** Stable reply id for an existing user message with no reply yet. */
      newAssistantMessageId?: string;
      /** Same desktop session only; retries reuse the original revision. */
      syncRevision?: { sessionId: string; sequence: number };
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
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      /** Chat terminal state; absent clears an earlier stop, limit or failure. */
      finishReason?: MessageFinishReason;
    }) => Promise<{ success: boolean }>;
  };
  channels: {
    list: () => Promise<{ channels: ApiChannel[] }>;
    get: (id: string) => Promise<{ channel: ApiChannel }>;
    create: (data: {
      name: string;
      provider: string;
      protocol?: "openai" | "anthropic" | "google" | "acp";
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
        protocol?: "openai" | "anthropic" | "google" | "acp";
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
    refreshContext: (id: string) => Promise<{
      success: boolean;
      models: ApiChannelModel[];
      updated: number;
      error?: string;
    }>;
    listModels: (id: string) => Promise<{ models: ApiChannelModel[] }>;
    updateModels: (
      id: string,
      data: {
        models: Array<{
          modelId: string;
          displayName?: string;
          contextWindow?: number | null;
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
    getCredentials: (
      id: string,
      modelId?: string,
    ) => Promise<{
      credentials: {
        apiKey: string;
        baseUrl: string | null;
        modelId: string;
        contextWindow?: number | null;
        contextMetadata?: ModelContextMetadata | null;
        protocol: "openai" | "anthropic" | "google" | "acp";
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
      /** ImportSource id when the entry comes from the import center / MCP import dialog. */
      importedFrom?: string;
    }) => Promise<{ server: { id: string; name: string } }>;
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
  dataTransfer: {
    estimateExport: () => Promise<ExportEstimate>;
    exportBackup: (outputDir?: string) => Promise<ExportBackupResult>;
    exportDTI: () => Promise<object[]>;
    detectFormat: (filePath: string) => Promise<{ format: string }>;
    importData: (filePath: string, format?: string) => Promise<ImportResult>;
  };
  importRecords: {
    list: (params?: { limit?: number; cursor?: string }) => Promise<ApiImportRecordListResult>;
    get: (id: string) => Promise<{ record: ApiImportRecord }>;
    create: (data: CreateImportRecordInput) => Promise<{ record: ApiImportRecord }>;
    remove: (id: string) => Promise<{ success: boolean }>;
  };
  localImport: {
    scan: () => Promise<LocalImportScanResult>;
    listConversations: (
      source: LocalImportServerSource,
    ) => Promise<LocalImportConversationListResult>;
    run: (data: LocalImportRunRequest) => Promise<LocalImportRunResult>;
  };
  prompts: {
    /** Prompt templates stored under the `prompts.templates` settings key. */
    templates: () => Promise<PromptTemplate[]>;
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

/**
 * Per-request system-prompt addendum (the generative-UI section) for the
 * server-side regenerate / edit LLM call. Only sent when it is a non-empty string.
 */
function withAppendSystemPrompt<T extends { appendSystemPrompt?: string }>(
  body: T,
): Omit<T, "appendSystemPrompt"> & { appendSystemPrompt?: string } {
  const { appendSystemPrompt, ...rest } = body;
  return typeof appendSystemPrompt === "string" && appendSystemPrompt.trim()
    ? { ...rest, appendSystemPrompt }
    : rest;
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

/**
 * A plain `fetch` that reports server reachability like every `ServerApi` call:
 * a response marks the server up, a network failure marks it down (and starts
 * the automatic reconnect). Stores that build their own requests use this so an
 * outage — or a recovery — is never invisible to the connection store.
 */
export function fetchWithBackendStatus(url: string, init?: RequestInit): Promise<Response> {
  return requestWithBackendStatus(fetch, url, { credentials: "include", ...init });
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
    if (path === "/data-transfer/export/backup" && response.status === 413) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (body?.errorCode === "backup_size_limit") throw new BackupSizeLimitError();
    }
    // Only the prepare endpoint owns this saved pair. Do not interpret arbitrary
    // response bodies as permission to rename messages in another operation.
    if (path === "/messages/chat/prepare") {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        body &&
        typeof body.userMessageId === "string" &&
        typeof body.assistantMessageId === "string" &&
        (body.code === "chat_context_budget_exceeded" || body.code === "chat_preparation_failed")
      ) {
        throw new ChatPreparationFailure(
          extractErrorMessage(body, "Failed to prepare chat"),
          body.userMessageId,
          body.assistantMessageId,
          body.code,
        );
      }
    }
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
      autoTitle: (id, prompt) =>
        fetchJson(fetchImpl, baseUrl, `/conversations/${encodeURIComponent(id)}/auto-title`, {
          method: "POST",
          body: JSON.stringify({ prompt }),
        }),
    },

    projects: {
      list: () => fetchJson(fetchImpl, baseUrl, "/projects"),
      create: (data) =>
        fetchJson(fetchImpl, baseUrl, "/projects", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      update: (id, data) =>
        fetchJson(fetchImpl, baseUrl, `/projects/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(data),
        }),
      delete: (id) =>
        fetchJson(fetchImpl, baseUrl, `/projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },

    messages: {
      list: (conversationId) =>
        fetchJson(fetchImpl, baseUrl, `/messages/${encodeURIComponent(conversationId)}`),
      search: (query) =>
        fetchJson(fetchImpl, baseUrl, `/messages/search?q=${encodeURIComponent(query)}`),
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
            body: data ? JSON.stringify(withAppendSystemPrompt(data)) : undefined,
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
            body: JSON.stringify(
              withAppendSystemPrompt({
                content,
                appendSystemPrompt: options?.appendSystemPrompt,
              }),
            ),
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
      refreshContext: (id) =>
        fetchJson(fetchImpl, baseUrl, `/channels/${encodeURIComponent(id)}/context-capabilities`, {
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
      getCredentials: (id, modelId) =>
        fetchJson(
          fetchImpl,
          baseUrl,
          `/channels/${encodeURIComponent(id)}/credentials${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ""}`,
        ),
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

    dataTransfer: {
      estimateExport: () => fetchJson(fetchImpl, baseUrl, "/data-transfer/export/estimate"),
      exportBackup: (outputDir) =>
        fetchJson(fetchImpl, baseUrl, "/data-transfer/export/backup", {
          method: "POST",
          body: JSON.stringify({ outputDir }),
        }),
      exportDTI: () =>
        fetchJson(fetchImpl, baseUrl, "/data-transfer/export/dti", {
          method: "POST",
        }),
      detectFormat: (filePath) =>
        fetchJson(fetchImpl, baseUrl, "/data-transfer/import/detect", {
          method: "POST",
          body: JSON.stringify({ filePath }),
        }),
      importData: (filePath, format) =>
        fetchJson(fetchImpl, baseUrl, "/data-transfer/import", {
          method: "POST",
          body: JSON.stringify({ filePath, format }),
        }),
    },

    importRecords: {
      list: (params) => {
        const query = new URLSearchParams();
        if (params?.limit) query.set("limit", String(params.limit));
        if (params?.cursor) query.set("cursor", params.cursor);
        const suffix = query.toString();
        return fetchJson(fetchImpl, baseUrl, `/import/records${suffix ? `?${suffix}` : ""}`);
      },
      get: (id) => fetchJson(fetchImpl, baseUrl, `/import/records/${encodeURIComponent(id)}`),
      create: (data) =>
        fetchJson(fetchImpl, baseUrl, "/import/records", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      remove: (id) =>
        fetchJson(fetchImpl, baseUrl, `/import/records/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },

    localImport: {
      scan: () => fetchJson(fetchImpl, baseUrl, "/import/local/scan", { method: "POST" }),
      listConversations: (source) =>
        fetchJson(
          fetchImpl,
          baseUrl,
          `/import/local/conversations?source=${encodeURIComponent(source)}`,
        ),
      run: (data) =>
        fetchJson(fetchImpl, baseUrl, "/import/local/run", {
          method: "POST",
          body: JSON.stringify(data),
        }),
    },

    prompts: {
      templates: async () => {
        const { settings } = await fetchJson<{ settings: ApiSettingsMap }>(
          fetchImpl,
          baseUrl,
          `/settings?keys=${encodeURIComponent(PROMPT_TEMPLATES_SETTING_KEY)}`,
        );
        return parsePromptTemplates(settings?.[PROMPT_TEMPLATES_SETTING_KEY]);
      },
    },
  };
}

/**
 * Parses the raw `prompts.templates` settings value. Malformed entries are
 * dropped rather than failing the whole list so one bad import cannot hide
 * every other template from the slash panel.
 */
export function parsePromptTemplates(raw: string | null | undefined): PromptTemplate[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PromptTemplate[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
    if (typeof entry.body !== "string" || typeof entry.source !== "string") continue;
    out.push({
      id: entry.id,
      name: entry.name,
      namespace: typeof entry.namespace === "string" ? entry.namespace : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined,
      argumentHint: typeof entry.argumentHint === "string" ? entry.argumentHint : undefined,
      body: entry.body,
      source: entry.source as PromptTemplate["source"],
      importedAt: typeof entry.importedAt === "number" ? entry.importedAt : 0,
    });
  }
  return out;
}
