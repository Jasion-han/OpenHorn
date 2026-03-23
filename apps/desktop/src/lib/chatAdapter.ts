import { createServerApi, readErrorMessage, type ServerApi } from "./serverApi";
import type {
  ApiAgentRun,
  ApiCitation,
  ApiConversation,
  ApiLiveMetadata,
  ApiMessage,
  Channel,
  ChannelModel,
  Conversation,
  CreateConversationInput,
  Message,
  MessageAttachmentMeta,
  SendMessageInput,
  UpdateConversationInput,
} from "../types/chat";

export interface ChatAdapter {
  listChannels: () => Promise<Channel[]>;
  listConversations: () => Promise<Conversation[]>;
  createConversation: (input: CreateConversationInput) => Promise<Conversation>;
  updateConversation: (conversationId: string, updates: UpdateConversationInput) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<Message[]>;
  sendMessage: (input: SendMessageInput) => Promise<Response>;
  deleteMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (
    messageId: string,
    data?: { userMessageId?: string; userContent?: string },
  ) => Promise<Response>;
  editUserMessage: (messageId: string, content: string) => Promise<Response>;
  abortActiveStream: () => void;
  getSettings: (keys: string[]) => Promise<Record<string, string>>;
}

function mapChannelModel(model: {
  id: string;
  channelId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}): ChannelModel {
  return {
    id: model.id,
    channelId: model.channelId,
    modelId: model.modelId,
    displayName: model.displayName,
    enabled: model.enabled,
    isDefault: model.isDefault,
    createdAt: new Date(model.createdAt),
    updatedAt: new Date(model.updatedAt),
  };
}

function mapConversation(conversation: ApiConversation): Conversation {
  return {
    id: conversation.id,
    title: conversation.title,
    channelId: conversation.channelId || undefined,
    modelId: conversation.modelId || undefined,
    systemPrompt: conversation.systemPrompt || undefined,
    contextLength: conversation.contextLength ?? 4096,
    defaultMode: conversation.defaultMode === "chat" ? "chat" : "agent",
    lastMode: conversation.lastMode === "chat" ? "chat" : "agent",
    isPinned: Boolean(conversation.isPinned),
    forceWebSearch:
      conversation.forceWebSearch == null ? true : Boolean(conversation.forceWebSearch),
    runStatus: conversation.runStatus ?? null,
    createdAt: new Date(conversation.createdAt),
    updatedAt: new Date(conversation.updatedAt),
  };
}

function parseJsonValue<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function mapAttachmentsMeta(value: unknown): MessageAttachmentMeta[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items: MessageAttachmentMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    if (!fileName) continue;

    items.push({
      id: typeof record.id === "string" ? record.id : undefined,
      fileName,
      fileType: typeof record.fileType === "string" ? record.fileType : undefined,
      fileSize: typeof record.fileSize === "number" ? record.fileSize : undefined,
      previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : undefined,
    });
  }

  return items.length > 0 ? items : undefined;
}

function mapMessage(message: ApiMessage): Message {
  const attachments = parseJsonValue<string[]>(message.attachments);
  const agentRun = parseJsonValue<ApiAgentRun>(message.agentRun);
  const liveMetadata = parseJsonValue<ApiLiveMetadata>(message.liveMetadata);
  const citations = parseJsonValue<ApiCitation[]>(message.citations);

  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    model: message.model || undefined,
    mode: message.mode === "chat" ? "chat" : "agent",
    attachments,
    agentRun,
    attachmentsMeta: mapAttachmentsMeta(message.attachmentsMeta),
    liveStatus: liveMetadata?.status,
    liveRoute: liveMetadata?.route,
    liveLabel: liveMetadata?.label,
    citations,
    createdAt: new Date(message.createdAt),
  };
}

function mapChannel(channel: {
  id: string;
  userId: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  models: Array<{
    id: string;
    channelId: string;
    modelId: string;
    displayName: string;
    enabled: boolean;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  defaultModelId: string | null;
  legacyModel: string | null;
  hasApiKey: boolean;
}): Channel {
  return {
    id: channel.id,
    userId: channel.userId,
    name: channel.name,
    provider: channel.provider,
    baseUrl: channel.baseUrl || undefined,
    enabled: channel.enabled,
    isDefault: channel.isDefault,
    createdAt: new Date(channel.createdAt),
    updatedAt: new Date(channel.updatedAt),
    models: channel.models.map(mapChannelModel),
    defaultModelId: channel.defaultModelId || undefined,
    legacyModel: channel.legacyModel || undefined,
    hasApiKey: channel.hasApiKey,
  };
}

export function createChatAdapter(api: ServerApi = createServerApi()): ChatAdapter {
  let activeController: AbortController | null = null;

  return {
    async listChannels() {
      const { channels } = await api.channels.list();
      return channels.map(mapChannel);
    },

    async listConversations() {
      const { conversations } = await api.conversations.list();
      return conversations.map(mapConversation);
    },

    async createConversation(input) {
      const { conversation } = await api.conversations.create(input);
      return mapConversation(conversation);
    },

    async updateConversation(conversationId, updates) {
      await api.conversations.update(conversationId, updates);
    },

    async deleteConversation(conversationId) {
      await api.conversations.delete(conversationId);
    },

    async loadMessages(conversationId) {
      const { messages } = await api.messages.list(conversationId);
      return messages.map(mapMessage);
    },

    async sendMessage(input) {
      if (activeController) {
        activeController.abort();
      }

      const controller = new AbortController();
      activeController = controller;

      const response = await api.messages.stream(input, { signal: controller.signal });
      if (!response.ok) {
        if (activeController === controller) {
          activeController = null;
        }
        throw new Error(await readErrorMessage(response, "Failed to stream message"));
      }

      return response;
    },

    async deleteMessage(messageId) {
      await api.messages.delete(messageId);
    },

    async regenerateMessage(messageId, data) {
      if (activeController) {
        activeController.abort();
      }

      const controller = new AbortController();
      activeController = controller;

      const response = await api.messages.regenerate(messageId, data, {
        signal: controller.signal,
      });
      if (!response.ok) {
        if (activeController === controller) {
          activeController = null;
        }
        throw new Error(await readErrorMessage(response, "Failed to regenerate message"));
      }

      return response;
    },

    async editUserMessage(messageId, content) {
      if (activeController) {
        activeController.abort();
      }

      const controller = new AbortController();
      activeController = controller;

      const response = await api.messages.edit(messageId, content, {
        signal: controller.signal,
      });
      if (!response.ok) {
        if (activeController === controller) {
          activeController = null;
        }
        throw new Error(await readErrorMessage(response, "Failed to edit message"));
      }

      return response;
    },

    abortActiveStream() {
      activeController?.abort();
      activeController = null;
    },

    async getSettings(keys) {
      const { settings } = await api.settings.get(keys);
      return settings;
    },
  };
}
