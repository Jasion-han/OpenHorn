import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { channelModels, channels } from 'db';
import { decrypt, encrypt, generateId } from '../utils';

type ChannelRow = typeof channels.$inferSelect;

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
  apiKey: string;
  baseUrl?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface UpdateChannelInput {
  name?: string;
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

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com',
};

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-3-5-sonnet-20241022',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  google: 'gemini-1.5-pro',
};

function getDefaultBaseUrl(provider: string): string | null {
  return PROVIDER_DEFAULT_BASE_URLS[provider] || null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function normalizeAnthropicApiBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  url = url.replace(/\/messages$/, '');
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`;
  }
  return url;
}

function normalizeAnthropicRuntimeBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  url = url.replace(/\/messages$/, '');
  return url.replace(/\/v\d+$/, '');
}

function ensureSingleDefaultModel(models: UpdateChannelModelsInput['models']) {
  let defaultAssigned = false;

  return models.map((model, index) => {
    const isDefault = Boolean(model.isDefault);
    if (isDefault && !defaultAssigned) {
      defaultAssigned = true;
      return { ...model, isDefault: true };
    }

    if (isDefault && defaultAssigned) {
      return { ...model, isDefault: false };
    }

    if (!defaultAssigned && index === 0) {
      defaultAssigned = true;
      return { ...model, isDefault: true };
    }

    return { ...model, isDefault: false };
  });
}

async function ensureLegacyModelMigrated(channelId: string) {
  const existingChannel = await db.select().from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (existingChannel.length === 0 || !existingChannel[0].model) {
    return;
  }

  const existingModels = await db.select().from(channelModels)
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

  const rows = await db.select().from(channelModels)
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
    const defaultModel = models.find((model) => model.isDefault) || models[0] || null;

    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      provider: row.provider,
      baseUrl: row.baseUrl || getDefaultBaseUrl(row.provider),
      enabled: Boolean(row.enabled ?? true),
      isDefault: Boolean(row.isDefault),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      models,
      defaultModelId: defaultModel?.modelId || row.model || null,
      legacyModel: row.model || null,
      hasApiKey: Boolean(row.apiKey),
    } satisfies ChannelItem;
  });
}

async function getOwnedChannelRow(userId: string, channelId: string) {
  const rows = await db.select().from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error('Channel not found');
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
  await db.update(channels)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(channels.userId, userId));

  await db.update(channels)
    .set({ isDefault: true, updatedAt: now })
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
}

async function setDefaultModelInternal(channelId: string, modelId: string) {
  const now = new Date();
  await db.update(channelModels)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(channelModels.channelId, channelId));

  await db.update(channelModels)
    .set({ isDefault: true, updatedAt: now })
    .where(and(eq(channelModels.channelId, channelId), eq(channelModels.modelId, modelId)));
}

function getRuntimeBaseUrl(provider: string, baseUrl: string | null) {
  const fallback = getDefaultBaseUrl(provider);
  const url = normalizeBaseUrl(baseUrl || fallback || '');

  if (provider === 'anthropic') {
    return normalizeAnthropicRuntimeBaseUrl(url);
  }

  return url || undefined;
}

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Failed to fetch models (${response.status})`);
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  return (data.data || []).map((item) => ({
    modelId: item.id,
    displayName: item.id,
  }));
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeAnthropicApiBaseUrl(baseUrl)}/models`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Failed to fetch models (${response.status})`);
  }

  const data = await response.json() as {
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
    const text = await response.text().catch(() => '');
    throw new Error(text || `Failed to fetch models (${response.status})`);
  }

  const data = await response.json() as {
    models?: Array<{
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  return (data.models || [])
    .filter((item) => item.supportedGenerationMethods?.includes('generateContent'))
    .map((item) => {
      const modelId = item.name.replace(/^models\//, '');
      return {
        modelId,
        displayName: item.displayName || modelId,
      };
    });
}

async function fetchProviderModels(provider: string, baseUrl: string, apiKey: string) {
  if (provider === 'anthropic') {
    return fetchAnthropicModels(baseUrl, apiKey);
  }

  if (provider === 'google') {
    return fetchGoogleModels(baseUrl, apiKey);
  }

  return fetchOpenAICompatibleModels(baseUrl, apiKey);
}

async function testOpenAICompatibleChannel(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed (${response.status})`);
  }
}

async function testAnthropicChannel(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeAnthropicApiBaseUrl(baseUrl)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  if (!response.ok && response.status !== 400) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed (${response.status})`);
  }
}

async function testGoogleChannel(baseUrl: string, apiKey: string) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1beta/models?key=${apiKey}`);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed (${response.status})`);
  }
}

export async function getChannels(userId: string) {
  const rows = await db.select().from(channels)
    .where(eq(channels.userId, userId));

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
  const existingChannels = await db.select({ id: channels.id }).from(channels)
    .where(eq(channels.userId, userId))
    .limit(1);
  const shouldSetDefault = input.isDefault ?? existingChannels.length === 0;

  if (shouldSetDefault) {
    await db.update(channels)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(channels.userId, userId));
  }

  await db.insert(channels).values({
    id,
    userId,
    name: input.name.trim(),
    provider: input.provider,
    apiKey: encrypt(input.apiKey.trim()),
    baseUrl: normalizeBaseUrl(input.baseUrl || getDefaultBaseUrl(input.provider) || ''),
    enabled: input.enabled ?? true,
    isDefault: shouldSetDefault,
    createdAt: now,
    updatedAt: now,
  });

  const defaultModelId = PROVIDER_DEFAULT_MODELS[input.provider];
  if (defaultModelId) {
    await db.insert(channelModels).values({
      id: generateId(),
      channelId: id,
      modelId: defaultModelId,
      displayName: defaultModelId,
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.update(channels)
      .set({ model: defaultModelId, updatedAt: now })
      .where(eq(channels.id, id));
  }

  return getOwnedChannelItem(userId, id);
}

export async function updateChannel(userId: string, channelId: string, input: UpdateChannelInput) {
  await getOwnedChannelRow(userId, channelId);

  if (input.isDefault) {
    await setDefaultChannelInternal(userId, channelId);
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    updates.name = input.name.trim();
  }

  if (input.baseUrl !== undefined) {
    updates.baseUrl = normalizeBaseUrl(input.baseUrl);
  }

  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
  }

  if (input.isDefault !== undefined) {
    updates.isDefault = input.isDefault;
  }

  if (input.apiKey?.trim()) {
    updates.apiKey = encrypt(input.apiKey.trim());
  }

  await db.update(channels)
    .set(updates)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  if (input.isDefault === false) {
    await db.update(channels)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
  }

  return getOwnedChannelItem(userId, channelId);
}

export async function deleteChannel(userId: string, channelId: string) {
  await getOwnedChannelRow(userId, channelId);

  await db.delete(channelModels).where(eq(channelModels.channelId, channelId));
  await db.delete(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));

  return { success: true };
}

export async function listChannelModels(userId: string, channelId: string) {
  await getOwnedChannelRow(userId, channelId);
  const channel = await getOwnedChannelItem(userId, channelId);
  return channel.models;
}

export async function updateChannelModels(userId: string, channelId: string, input: UpdateChannelModelsInput) {
  await getOwnedChannelRow(userId, channelId);

  const normalizedModels = ensureSingleDefaultModel(
    input.models
      .map((model) => ({
        modelId: model.modelId.trim(),
        displayName: (model.displayName || model.modelId).trim(),
        enabled: model.enabled ?? true,
        isDefault: model.isDefault ?? false,
      }))
      .filter((model) => model.modelId.length > 0)
  );

  const existingModels = await db.select().from(channelModels)
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
      await db.update(channelModels)
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
  await db.update(channels)
    .set({
      model: defaultModel?.modelId || null,
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId));

  return listChannelModels(userId, channelId);
}

export async function setDefaultChannel(userId: string, channelId: string) {
  await getOwnedChannelRow(userId, channelId);
  await setDefaultChannelInternal(userId, channelId);
  return { success: true };
}

export async function setDefaultChannelModel(userId: string, channelId: string, modelId: string) {
  await getOwnedChannelRow(userId, channelId);

  const models = await listChannelModels(userId, channelId);
  const target = models.find((model) => model.modelId === modelId);
  if (!target) {
    throw new Error('Model not found');
  }

  await setDefaultModelInternal(channelId, modelId);
  await db.update(channels)
    .set({ model: modelId, updatedAt: new Date() })
    .where(eq(channels.id, channelId));

  return { success: true };
}

export async function fetchChannelModels(userId: string, channelId: string): Promise<FetchModelsResult> {
  const channel = await getOwnedChannelRow(userId, channelId);
  const apiKey = decrypt(channel.apiKey);
  const baseUrl = channel.baseUrl || getDefaultBaseUrl(channel.provider);

  if (!baseUrl) {
    return { success: false, error: 'Base URL is required', models: [] };
  }

  try {
    const models = await fetchProviderModels(channel.provider, baseUrl, apiKey);
    const existingModels = await listChannelModels(userId, channelId);
    const existingByModelId = new Map(existingModels.map((model) => [model.modelId, model]));
    const now = new Date();

    for (const model of models) {
      const existing = existingByModelId.get(model.modelId);
      if (existing) {
        await db.update(channelModels)
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
        isDefault: existingModels.length === 0 && models[0]?.modelId === model.modelId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updatedModels = await listChannelModels(userId, channelId);
    if (updatedModels.length > 0 && !updatedModels.some((model) => model.isDefault)) {
      await setDefaultModelInternal(channelId, updatedModels[0].modelId);
      await db.update(channels)
        .set({ model: updatedModels[0].modelId, updatedAt: new Date() })
        .where(eq(channels.id, channelId));
    }

    return {
      success: true,
      models: await listChannelModels(userId, channelId),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch models',
      models: [],
    };
  }
}

export async function testChannel(userId: string, channelId: string): Promise<ChannelTestResult> {
  try {
    const channel = await getOwnedChannelRow(userId, channelId);
    const apiKey = decrypt(channel.apiKey);
    const baseUrl = channel.baseUrl || getDefaultBaseUrl(channel.provider);

    if (!baseUrl) {
      return { success: false, error: 'Base URL is required' };
    }

    if (channel.provider === 'anthropic') {
      await testAnthropicChannel(baseUrl, apiKey);
    } else if (channel.provider === 'google') {
      await testGoogleChannel(baseUrl, apiKey);
    } else {
      await testOpenAICompatibleChannel(baseUrl, apiKey);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getResolvedChannelForUser(userId: string, requestedChannelId?: string | null): Promise<ResolvedChannel | null> {
  const targetChannel = requestedChannelId
    ? await getOwnedChannelItem(userId, requestedChannelId)
    : (await getChannels(userId)).find((channel) => channel.isDefault) || null;

  if (!targetChannel || !targetChannel.enabled) {
    return null;
  }

  const row = await getOwnedChannelRow(userId, targetChannel.id);
  const defaultModel = targetChannel.models.find((model) => model.isDefault && model.enabled)
    || targetChannel.models.find((model) => model.enabled)
    || null;

  const modelId = defaultModel?.modelId || targetChannel.legacyModel;
  if (!modelId) {
    return null;
  }

  const channelWithRuntimeBaseUrl: ChannelItem = {
    ...targetChannel,
    baseUrl: getRuntimeBaseUrl(targetChannel.provider, row.baseUrl || targetChannel.baseUrl),
  };

  return {
    channel: channelWithRuntimeBaseUrl,
    apiKey: decrypt(row.apiKey),
    modelId,
  };
}

export async function getResolvedChannelById(userId: string, channelId: string) {
  return getResolvedChannelForUser(userId, channelId);
}
