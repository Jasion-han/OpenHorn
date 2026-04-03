import { agentSessions, agentTasks, channelModels, channels, conversations } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { decrypt, encrypt, generateId } from "../utils";
import { probeAnthropicModel } from "./anthropicProbe";
import { summarizeProviderError } from "./providerErrorSummary";

type ChannelRow = typeof channels.$inferSelect;
export type ChannelProtocol = "openai" | "anthropic" | "google";

export interface ChannelModelItem {
  id: string;
  channelId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelItem {
  id: string;
  userId: string;
  name: string;
  provider: string;
  protocol: ChannelProtocol;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  models: ChannelModelItem[];
  defaultModelId: string | null;
  legacyModel: string | null;
  hasApiKey: boolean;
}

export interface CreateChannelInput {
  name: string;
  provider: string;
  protocol?: ChannelProtocol;
  apiKey: string;
  baseUrl?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface UpdateChannelInput {
  name?: string;
  provider?: string;
  protocol?: ChannelProtocol;
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface UpdateChannelModelsInput {
  models: Array<{
    modelId: string;
    displayName?: string;
    enabled?: boolean;
    isDefault?: boolean;
  }>;
}

export interface ChannelTestResult {
  success: boolean;
  error?: string;
}

export interface FetchModelsResult {
  success: boolean;
  error?: string;
  models: ChannelModelItem[];
}

export interface ResolvedChannel {
  channel: ChannelItem;
  apiKey: string;
  modelId: string;
}

const PROTOCOL_DEFAULT_BASE_URLS: Record<ChannelProtocol, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com",
};

function inferProtocolFromProvider(provider: string | null | undefined): ChannelProtocol {
  const normalized = (provider || "").trim().toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "google" || normalized === "gemini") return "google";
  return "openai";
}

function normalizeProtocol(
  protocol: string | null | undefined,
  fallbackProvider?: string | null | undefined,
): ChannelProtocol {
  const normalized = (protocol || "").trim().toLowerCase();
  if (normalized === "anthropic") return "anthropic";
  if (normalized === "google" || normalized === "gemini") return "google";
  if (normalized === "openai") return "openai";
  return inferProtocolFromProvider(fallbackProvider);
}

function getDefaultBaseUrl(protocol: ChannelProtocol): string {
  return PROTOCOL_DEFAULT_BASE_URLS[protocol];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function normalizeOpenAICompatibleApiBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (hostname === "openrouter.ai") {
      if (!pathname || pathname === "/api" || pathname === "/v1" || pathname === "/api/v1") {
        parsed.pathname = "/api/v1";
        return normalizeBaseUrl(parsed.toString());
      }
    }
  } catch {
    // Ignore invalid URLs and fall back to generic normalization below.
  }
  // Accept users pasting full endpoints; canonicalize to .../v1
  for (let i = 0; i < 3; i++) {
    url = url.replace(/\/(chat\/completions|completions|models)$/, "");
    url = url.replace(/\/messages(\/v\d+)?$/, "");
    url = url.replace(/\/v\d+\/messages(\/v\d+)?$/, (match) =>
      match.replace(/\/messages(\/v\d+)?$/, ""),
    );
  }
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`;
  }
  return url;
}

function normalizeAnthropicApiBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  url = url.replace(/\/messages$/, "");
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`;
  }
  return url;
}

function normalizeAgentSdkRuntimeBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  // Relays sometimes mix Anthropic/OpenAI-style paths; be tolerant.
  // Keep stripping until stable for common suffix combos like:
  // - /v1
  // - /messages
  // - /v1/messages
  // - /v1/messages/v1 (when an OpenAI normalizer appended /v1)
  for (let i = 0; i < 3; i++) {
    url = url.replace(/\/v\d+$/, "");
    url = url.replace(/\/messages$/, "");
  }
  return url;
}

function normalizeChannelBaseUrl(protocol: ChannelProtocol, baseUrl: string): string {
  if (protocol === "anthropic") {
    // Store whatever user provides (root or /v1); runtime/API normalizers handle both.
    return normalizeBaseUrl(baseUrl);
  }

  if (protocol === "google") {
    return normalizeBaseUrl(baseUrl);
  }

  // Default: OpenAI-compatible
  return normalizeOpenAICompatibleApiBaseUrl(baseUrl);
}

function ensureSingleDefaultModel(models: UpdateChannelModelsInput["models"]) {
  // Do not silently pick a default; only ensure there's at most one.
  // If callers want a default, they must explicitly set it.
  let defaultAssigned = false;
  return models.map((model) => {
    const wantsDefault = Boolean(model.isDefault);
    if (!wantsDefault) {
      return { ...model, isDefault: false };
    }
    if (defaultAssigned) {
      return { ...model, isDefault: false };
    }
    defaultAssigned = true;
    return { ...model, isDefault: true };
  });
}

function resolveStrictDefaultModelId(channel: ChannelItem): string | null {
  const def = channel.models.find((m) => m.isDefault && m.enabled);
  return def?.modelId || null;
}

async function ensureLegacyModelMigrated(channelId: string) {
  const existingChannel = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (existingChannel.length === 0 || !existingChannel[0].model) {
    return;
  }

  const existingModels = await db
    .select()
    .from(channelModels)
    .where(eq(channelModels.channelId, channelId))
    .limit(1);

  if (existingModels.length > 0) {
    return;
  }

  const now = new Date();
  await db.insert(channelModels).values({
    id: generateId(),
    channelId,
    modelId: existingChannel[0].model,
    displayName: existingChannel[0].model,
    enabled: true,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function listModelsByChannelIds(channelIds: string[]) {
  if (channelIds.length === 0) {
    return new Map<string, ChannelModelItem[]>();
  }

  await Promise.all(channelIds.map((channelId) => ensureLegacyModelMigrated(channelId)));

  const rows = await db
    .select()
    .from(channelModels)
    .where(inArray(channelModels.channelId, channelIds));

  const grouped = new Map<string, ChannelModelItem[]>();
  for (const row of rows) {
    const list = grouped.get(row.channelId) || [];
    list.push({
      id: row.id,
      channelId: row.channelId,
      modelId: row.modelId,
      displayName: row.displayName,
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.isDefault),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    grouped.set(row.channelId, list);
  }

  for (const models of grouped.values()) {
    models.sort((a, b) => {
      if (a.isDefault === b.isDefault) {
        return a.displayName.localeCompare(b.displayName);
      }
      return a.isDefault ? -1 : 1;
    });
  }

  return grouped;
}

async function buildChannelItems(channelRows: ChannelRow[]) {
  const modelsByChannel = await listModelsByChannelIds(channelRows.map((row) => row.id));

  return channelRows.map((row) => {
    const models = modelsByChannel.get(row.id) || [];
    const defaultModel = models.find((model) => model.isDefault && model.enabled) || null;
    const protocol = normalizeProtocol(row.protocol, row.provider);

    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      provider: row.provider,
      protocol,
      baseUrl: row.baseUrl || getDefaultBaseUrl(protocol),
      enabled: Boolean(row.enabled ?? true),
      isDefault: Boolean(row.isDefault),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      models,
      // Strict: do not pretend a default exists (no "models[0]" fallback).
      defaultModelId: defaultModel?.modelId || null,
      legacyModel: row.model || null,
      hasApiKey: Boolean(row.apiKey),
    } satisfies ChannelItem;
  });
}

async function getOwnedChannelRow(userId: string, channelId: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Channel not found");
  }

  return rows[0];
}

async function getOwnedChannelItem(userId: string, channelId: string) {
  const row = await getOwnedChannelRow(userId, channelId);
  const items = await buildChannelItems([row]);
  return items[0];
}

async function setDefaultChannelInternal(userId: string, channelId: string) {
  const now = new Date();
  await db
    .update(channels)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(channels.userId, userId));

  await db
    .update(channels)
    .set({ isDefault: true, updatedAt: now })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
}

async function setDefaultModelInternal(channelId: string, modelId: string) {
  const now = new Date();
  await db
    .update(channelModels)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(channelModels.channelId, channelId));

  await db
    .update(channelModels)
    .set({ isDefault: true, updatedAt: now })
    .where(and(eq(channelModels.channelId, channelId), eq(channelModels.modelId, modelId)));
}

function getRuntimeBaseUrl(protocol: ChannelProtocol, baseUrl: string | null) {
  const fallback = getDefaultBaseUrl(protocol);
  const url = normalizeBaseUrl(baseUrl || fallback || "");

  if (protocol === "anthropic") {
    return normalizeAgentSdkRuntimeBaseUrl(url);
  }

  if (protocol === "google") {
    return url || undefined;
  }

  // OpenAI / DeepSeek and most relays are OpenAI-compatible. Make sure /v1 is present.
  return normalizeOpenAICompatibleApiBaseUrl(url) || undefined;
}

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeOpenAICompatibleApiBaseUrl(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      summarizeProviderError(text, {
        status: response.status,
        fallback: `Failed to fetch models (${response.status})`,
      }),
    );
  }

  const data = (await response.json()) as { data?: Array<{ id: string }> };
  return (data.data || []).map((item) => ({
    modelId: item.id,
    displayName: item.id,
  }));
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeAnthropicApiBaseUrl(baseUrl)}/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      summarizeProviderError(text, {
        status: response.status,
        fallback: `Failed to fetch models (${response.status})`,
      }),
    );
  }

  const data = (await response.json()) as {
    data?: Array<{ id: string; display_name?: string }>;
  };

  return (data.data || []).map((item) => ({
    modelId: item.id,
    displayName: item.display_name || item.id,
  }));
}

async function fetchGoogleModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1beta/models?key=${apiKey}`);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      summarizeProviderError(text, {
        status: response.status,
        fallback: `Failed to fetch models (${response.status})`,
      }),
    );
  }

  const data = (await response.json()) as {
    models?: Array<{
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  return (data.models || [])
    .filter((item) => item.supportedGenerationMethods?.includes("generateContent"))
    .map((item) => {
      const modelId = item.name.replace(/^models\//, "");
      return {
        modelId,
        displayName: item.displayName || modelId,
      };
    });
}

async function fetchProviderModels(protocol: ChannelProtocol, baseUrl: string, apiKey: string) {
  if (protocol === "anthropic") {
    return fetchAnthropicModels(baseUrl, apiKey);
  }

  if (protocol === "google") {
    return fetchGoogleModels(baseUrl, apiKey);
  }

  return fetchOpenAICompatibleModels(baseUrl, apiKey);
}

async function testOpenAICompatibleChannel(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeOpenAICompatibleApiBaseUrl(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      summarizeProviderError(text, {
        status: response.status,
        fallback: `Request failed (${response.status})`,
      }),
    );
  }
}

async function testGoogleChannel(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1beta/models?key=${apiKey}`);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      summarizeProviderError(text, {
        status: response.status,
        fallback: `Request failed (${response.status})`,
      }),
    );
  }
}

export async function getChannels(userId: string) {
  const rows = await db.select().from(channels).where(eq(channels.userId, userId));

  const items = await buildChannelItems(rows);
  items.sort((a, b) => {
    if (a.isDefault === b.isDefault) {
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    }
    return a.isDefault ? -1 : 1;
  });
  return items;
}

export async function getChannelById(userId: string, channelId: string) {
  return getOwnedChannelItem(userId, channelId);
}

export async function createChannel(userId: string, input: CreateChannelInput) {
  const id = generateId();
  const now = new Date();
  const provider = input.provider.trim();
  if (!provider) {
    throw new Error("provider is required");
  }
  const protocol = normalizeProtocol(input.protocol, provider);
  const existingChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.userId, userId))
    .limit(1);
  const shouldSetDefault = input.isDefault ?? existingChannels.length === 0;

  if (shouldSetDefault) {
    await db
      .update(channels)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(channels.userId, userId));
  }

  await db.insert(channels).values({
    id,
    userId,
    name: input.name.trim(),
    provider,
    protocol,
    apiKey: encrypt(input.apiKey.trim()),
    baseUrl: normalizeChannelBaseUrl(protocol, input.baseUrl || getDefaultBaseUrl(protocol) || ""),
    enabled: input.enabled ?? true,
    isDefault: shouldSetDefault,
    createdAt: now,
    updatedAt: now,
  });

  return getOwnedChannelItem(userId, id);
}

export async function updateChannel(userId: string, channelId: string, input: UpdateChannelInput) {
  const current = await getOwnedChannelRow(userId, channelId);

  if (input.isDefault) {
    await setDefaultChannelInternal(userId, channelId);
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    updates.name = input.name.trim();
  }

  let nextProvider = current.provider;
  let nextProtocol = normalizeProtocol(current.protocol, current.provider);
  if (input.provider !== undefined) {
    const trimmed = input.provider.trim();
    if (!trimmed) {
      throw new Error("provider is required");
    }
    nextProvider = trimmed;
    updates.provider = trimmed;
  }
  if (input.protocol !== undefined) {
    nextProtocol = normalizeProtocol(input.protocol, nextProvider);
    updates.protocol = nextProtocol;
  } else if (input.provider !== undefined) {
    nextProtocol = normalizeProtocol(current.protocol, nextProvider);
  }

  if (input.baseUrl !== undefined) {
    const trimmed = input.baseUrl.trim();
    updates.baseUrl = trimmed ? normalizeChannelBaseUrl(nextProtocol, trimmed) : null;
  } else if (
    nextProvider !== current.provider ||
    nextProtocol !== normalizeProtocol(current.protocol, current.provider)
  ) {
    // Provider/protocol changed but baseUrl not explicitly provided: keep existing baseUrl if present,
    // otherwise fill with the new protocol default.
    const preserved =
      current.baseUrl ||
      getDefaultBaseUrl(normalizeProtocol(current.protocol, current.provider)) ||
      getDefaultBaseUrl(nextProtocol);
    updates.baseUrl = preserved ? normalizeChannelBaseUrl(nextProtocol, preserved) : null;
  }

  if (input.enabled !== undefined) {
    if (input.enabled === false && current.isDefault) {
      throw new Error("该渠道是默认渠道，禁用前请先把其他渠道设为默认。");
    }
    updates.enabled = input.enabled;
  }

  if (input.isDefault !== undefined) {
    updates.isDefault = input.isDefault;
  }

  if (input.apiKey?.trim()) {
    updates.apiKey = encrypt(input.apiKey.trim());
  }

  await db
    .update(channels)
    .set(updates)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  if (
    nextProvider !== current.provider ||
    nextProtocol !== normalizeProtocol(current.protocol, current.provider)
  ) {
    // Protocol-bearing changes invalidate the cached model list and legacy model field.
    await db.delete(channelModels).where(eq(channelModels.channelId, channelId));
    await db
      .update(channels)
      .set({ model: null, updatedAt: new Date() })
      .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
  }

  if (input.isDefault === false) {
    await db
      .update(channels)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
  }

  return getOwnedChannelItem(userId, channelId);
}

export async function deleteChannel(userId: string, channelId: string) {
  const channel = await getOwnedChannelRow(userId, channelId);
  if (channel.isDefault) {
    const others = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, userId), eq(channels.isDefault, false)));
    if (others.length > 0) {
      throw new Error("该渠道是默认渠道，删除前请先把其他渠道设为默认。");
    }
  }

  await db
    .update(conversations)
    .set({ channelId: null, modelId: null, updatedAt: new Date() })
    .where(and(eq(conversations.userId, userId), eq(conversations.channelId, channelId)));

  await db
    .update(agentSessions)
    .set({ channelId: null, modelId: null, updatedAt: new Date() })
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.channelId, channelId)));

  await db
    .update(agentTasks)
    .set({ channelId: null, modelId: null, updatedAt: new Date() })
    .where(and(eq(agentTasks.userId, userId), eq(agentTasks.channelId, channelId)));

  await db.delete(channelModels).where(eq(channelModels.channelId, channelId));
  await db.delete(channels).where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  return { success: true };
}

export async function listChannelModels(userId: string, channelId: string) {
  await getOwnedChannelRow(userId, channelId);
  const channel = await getOwnedChannelItem(userId, channelId);
  return channel.models;
}

export async function updateChannelModels(
  userId: string,
  channelId: string,
  input: UpdateChannelModelsInput,
) {
  await getOwnedChannelRow(userId, channelId);

  const normalizedModels = ensureSingleDefaultModel(
    input.models
      .map((model) => ({
        modelId: model.modelId.trim(),
        displayName: (model.displayName || model.modelId).trim(),
        enabled: model.enabled ?? true,
        isDefault: model.isDefault ?? false,
      }))
      .filter((model) => model.modelId.length > 0),
  );

  const defaults = normalizedModels.filter((m) => m.isDefault);
  if (defaults.some((m) => !m.enabled)) {
    throw new Error("默认模型必须是启用状态。请先启用该模型，或选择其他启用的模型作为默认。");
  }

  const enabledModels = normalizedModels.filter((m) => m.enabled);
  if (enabledModels.length > 0 && defaults.length === 0) {
    throw new Error("请设置一个启用的默认模型（用于 Chat/Agent）。");
  }

  const existingModels = await db
    .select()
    .from(channelModels)
    .where(eq(channelModels.channelId, channelId));

  const existingByModelId = new Map(existingModels.map((model) => [model.modelId, model]));
  const nextModelIds = new Set(normalizedModels.map((model) => model.modelId));

  for (const model of existingModels) {
    if (!nextModelIds.has(model.modelId)) {
      await db.delete(channelModels).where(eq(channelModels.id, model.id));
    }
  }

  for (const model of normalizedModels) {
    const existing = existingByModelId.get(model.modelId);
    const now = new Date();

    if (existing) {
      await db
        .update(channelModels)
        .set({
          displayName: model.displayName,
          enabled: model.enabled,
          isDefault: model.isDefault,
          updatedAt: now,
        })
        .where(eq(channelModels.id, existing.id));
      continue;
    }

    await db.insert(channelModels).values({
      id: generateId(),
      channelId,
      modelId: model.modelId,
      displayName: model.displayName,
      enabled: model.enabled,
      isDefault: model.isDefault,
      createdAt: now,
      updatedAt: now,
    });
  }

  const defaultModel = normalizedModels.find((model) => model.isDefault);
  await db
    .update(channels)
    .set({
      model: defaultModel?.modelId || null,
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId));

  return listChannelModels(userId, channelId);
}

export async function setDefaultChannel(userId: string, channelId: string) {
  const channel = await getOwnedChannelRow(userId, channelId);
  if (!channel.enabled) {
    throw new Error("该渠道已被禁用，无法设为默认。");
  }
  await setDefaultChannelInternal(userId, channelId);
  return { success: true };
}

export async function setDefaultChannelModel(userId: string, channelId: string, modelId: string) {
  const channel = await getOwnedChannelRow(userId, channelId);
  if (!channel.enabled) {
    throw new Error("该渠道已被禁用，无法设置默认模型。");
  }

  const models = await listChannelModels(userId, channelId);
  const target = models.find((model) => model.modelId === modelId);
  if (!target) {
    throw new Error("Model not found");
  }
  if (!target.enabled) {
    throw new Error("该模型已被禁用，无法设为默认。");
  }

  await setDefaultModelInternal(channelId, modelId);
  await db
    .update(channels)
    .set({ model: modelId, updatedAt: new Date() })
    .where(eq(channels.id, channelId));

  return { success: true };
}

export async function fetchChannelModels(
  userId: string,
  channelId: string,
): Promise<FetchModelsResult> {
  const channel = await getOwnedChannelRow(userId, channelId);
  const protocol = normalizeProtocol(channel.protocol, channel.provider);
  const apiKey = decrypt(channel.apiKey);
  const baseUrl = channel.baseUrl || getDefaultBaseUrl(protocol);

  if (!baseUrl) {
    return { success: false, error: "Base URL is required", models: [] };
  }

  try {
    const models = await fetchProviderModels(protocol, baseUrl, apiKey);
    const existingModels = await listChannelModels(userId, channelId);
    const existingByModelId = new Map(existingModels.map((model) => [model.modelId, model]));
    const nextModelIds = new Set(models.map((m) => m.modelId));
    const now = new Date();

    // Remove models that no longer exist in provider list (authoritative sync).
    for (const model of existingModels) {
      if (!nextModelIds.has(model.modelId)) {
        await db.delete(channelModels).where(eq(channelModels.id, model.id));
      }
    }

    for (const model of models) {
      const existing = existingByModelId.get(model.modelId);
      if (existing) {
        await db
          .update(channelModels)
          .set({
            displayName: model.displayName,
            updatedAt: now,
          })
          .where(eq(channelModels.id, existing.id));
        continue;
      }

      await db.insert(channelModels).values({
        id: generateId(),
        channelId,
        modelId: model.modelId,
        displayName: model.displayName,
        enabled: true,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updatedModels = await listChannelModels(userId, channelId);
    const enabledModels = updatedModels.filter((m) => m.enabled);
    const defaultModel = updatedModels.find((m) => m.isDefault && m.enabled) || null;
    await db
      .update(channels)
      .set({ model: defaultModel?.modelId || null, updatedAt: new Date() })
      .where(eq(channels.id, channelId));

    return {
      success: true,
      // If user has enabled models but hasn't picked a default, warn (no auto fallback).
      error:
        enabledModels.length > 0 && !defaultModel
          ? "已同步模型列表，但未设置默认模型。请在该渠道下选择一个启用的默认模型（用于 Chat/Agent）。"
          : undefined,
      models: updatedModels,
    };
  } catch (error) {
    // Common pitfall: many "Claude relay" services expose an OpenAI-compatible API.
    // If user picked "anthropic" but the endpoint only supports OpenAI-compatible /v1/models,
    // give a concrete suggestion instead of a generic error.
    if (protocol === "anthropic") {
      try {
        await testOpenAICompatibleChannel(baseUrl, apiKey);
        return {
          success: false,
          error:
            "该 Base URL 看起来是 OpenAI 兼容接口（支持 /v1/models）。请按实际协议把渠道配置为 OpenAI 兼容类型后，再点击同步模型。",
          models: [],
        };
      } catch {
        // Ignore; fall through to the original error.
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch models",
      models: [],
    };
  }
}

export async function testChannel(userId: string, channelId: string): Promise<ChannelTestResult> {
  try {
    const channel = await getOwnedChannelItem(userId, channelId);
    const row = await getOwnedChannelRow(userId, channelId);
    const protocol = normalizeProtocol(row.protocol, channel.provider);
    const apiKey = decrypt(row.apiKey);
    const baseUrl = row.baseUrl || getDefaultBaseUrl(protocol);

    if (!baseUrl) {
      return { success: false, error: "Base URL is required" };
    }

    if (protocol === "anthropic") {
      const modelId = resolveModelIdFromChannelItem(channel, null);
      if (!modelId) {
        return {
          success: false,
          error: "请先为该渠道选择一个启用的默认模型后再测试连接。",
        };
      }

      const probe = await probeAnthropicModel(baseUrl, apiKey, modelId);
      if (probe.success === false) {
        if (probe.reason === "not_found" || probe.reason === "request") {
          try {
            await testOpenAICompatibleChannel(baseUrl, apiKey);
            return {
              success: false,
              error:
                "你当前选择的是 Anthropic，但该 Base URL/API Key 更像 OpenAI 兼容接口。建议按实际协议改为 OpenAI 兼容类型。",
            };
          } catch {
            // Fall back to the Anthropic probe error below.
          }
        }
        return { success: false, error: probe.error };
      }
    } else if (protocol === "google") {
      await testGoogleChannel(baseUrl, apiKey);
    } else {
      await testOpenAICompatibleChannel(baseUrl, apiKey);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function getResolvedChannelForUser(
  userId: string,
  requestedChannelId?: string | null,
): Promise<ResolvedChannel | null> {
  const targetChannel = requestedChannelId
    ? await getOwnedChannelItem(userId, requestedChannelId)
    : (await getChannels(userId)).find((channel) => channel.isDefault && channel.enabled) || null;

  if (!targetChannel || !targetChannel.enabled) {
    return null;
  }

  const row = await getOwnedChannelRow(userId, targetChannel.id);
  const modelId = resolveModelIdFromChannelItem(targetChannel, null);
  if (!modelId) {
    return null;
  }

  const channelWithRuntimeBaseUrl: ChannelItem = {
    ...targetChannel,
    baseUrl: getRuntimeBaseUrl(targetChannel.protocol, row.baseUrl || targetChannel.baseUrl),
  };

  return {
    channel: channelWithRuntimeBaseUrl,
    apiKey: decrypt(row.apiKey),
    modelId,
  };
}

export function resolveModelIdFromChannelItem(
  channel: ChannelItem,
  requestedModelId?: string | null,
): string | null {
  if (requestedModelId) {
    const exact = channel.models.find(
      (model) => model.modelId === requestedModelId && model.enabled,
    );
    if (exact) {
      return exact.modelId;
    }
    return null;
  }

  return resolveStrictDefaultModelId(channel);
}

export async function getResolvedChannelForConversation(
  userId: string,
  conversation: { channelId?: string | null; modelId?: string | null },
): Promise<ResolvedChannel | null> {
  const requestedChannelId =
    typeof conversation.channelId === "string" ? conversation.channelId : null;
  const requestedModelId = typeof conversation.modelId === "string" ? conversation.modelId : null;

  if (requestedChannelId) {
    const targetChannel = await getOwnedChannelItem(userId, requestedChannelId);
    if (!targetChannel?.enabled) {
      return null;
    }
    const row = await getOwnedChannelRow(userId, targetChannel.id);
    const modelId = requestedModelId
      ? targetChannel.models.find((model) => model.modelId === requestedModelId && model.enabled)
          ?.modelId || null
      : resolveModelIdFromChannelItem(targetChannel, null);
    if (!modelId) {
      return null;
    }

    const channelWithRuntimeBaseUrl: ChannelItem = {
      ...targetChannel,
      baseUrl: getRuntimeBaseUrl(targetChannel.protocol, row.baseUrl || targetChannel.baseUrl),
    };

    return {
      channel: channelWithRuntimeBaseUrl,
      apiKey: decrypt(row.apiKey),
      modelId,
    };
  }

  return getResolvedChannelForUser(userId, null);
}

export async function getResolvedChannelById(userId: string, channelId: string) {
  return getResolvedChannelForUser(userId, channelId);
}

function scoreVisionModelId(modelId: string) {
  const id = (modelId || "").toLowerCase();
  // Heuristic: prefer known vision-capable families.
  if (id.includes("gpt-4o")) return 100;
  if (id.includes("gpt-4.1")) return 95;
  if (id.includes("gpt-4")) return 90;
  if (id.includes("vision")) return 85;
  if (id.includes("claude-3")) return 80;
  if (id.includes("claude")) return 70;
  return 10;
}

export async function getResolvedVisionChannelForUser(
  userId: string,
): Promise<ResolvedChannel | null> {
  // Deprecated: Vision Extractor removed. Keep a best-effort heuristic resolver for any
  // future callers, but do not rely on settings.
  const items = await getChannels(userId);
  const enabled = items
    .filter((c) => c.enabled && c.hasApiKey)
    .map((c) => {
      const modelId = resolveModelIdFromChannelItem(c, null);
      return {
        channelId: c.id,
        protocol: c.protocol,
        provider: c.provider,
        baseUrl: c.baseUrl || "",
        modelId,
      };
    })
    .filter((c) => Boolean(c.modelId)) as Array<{
    channelId: string;
    protocol: ChannelProtocol;
    provider: string;
    baseUrl: string;
    modelId: string;
  }>;

  if (enabled.length === 0) return null;

  const ranked = enabled
    .map((c) => ({
      ...c,
      score:
        (c.protocol === "openai" ? 1000 : 0) +
        (c.protocol === "anthropic" && c.baseUrl.includes("api.anthropic.com") ? 200 : 0) +
        scoreVisionModelId(c.modelId),
    }))
    .sort((a, b) => b.score - a.score);

  for (const candidate of ranked) {
    const resolved = await getResolvedChannelForUser(userId, candidate.channelId);
    if (resolved) return resolved;
  }

  return null;
}

export async function getChannelRuntimeCredentialsById(
  userId: string,
  channelId: string,
  options?: { runtime?: "channel" | "agent_sdk" },
): Promise<{
  channel: ChannelItem;
  apiKey: string;
}> {
  const channel = await getOwnedChannelItem(userId, channelId);
  const row = await getOwnedChannelRow(userId, channelId);

  const storedOrDefaultBaseUrl =
    row.baseUrl || channel.baseUrl || getDefaultBaseUrl(channel.protocol) || "";

  const runtimeBaseUrl =
    options?.runtime === "agent_sdk" && channel.protocol === "anthropic"
      ? normalizeAgentSdkRuntimeBaseUrl(storedOrDefaultBaseUrl)
      : getRuntimeBaseUrl(channel.protocol, storedOrDefaultBaseUrl);

  const channelWithRuntimeBaseUrl: ChannelItem = {
    ...channel,
    baseUrl: runtimeBaseUrl,
  };

  return {
    channel: channelWithRuntimeBaseUrl,
    apiKey: decrypt(row.apiKey),
  };
}
