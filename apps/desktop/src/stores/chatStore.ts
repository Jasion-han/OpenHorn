import { create } from "zustand";
import { createChatAdapter, type ChatAdapter } from "../lib/chatAdapter";
import type {
  Channel,
  ChatMode,
  Conversation,
  Message,
  SendMessageInput,
} from "../types/chat";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function createDraftMessage(input: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  mode: ChatMode;
  attachments?: string[];
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    mode: input.mode,
    attachments: input.attachments,
    createdAt: new Date(),
  };
}

export interface ChatState {
  channels: Channel[];
  conversations: Conversation[];
  currentConversation: Conversation | null;
  messages: Message[];
  composerMode: ChatMode;
  selectedChannelId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;

  loadChannels: () => Promise<void>;
  loadConversations: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  createConversation: (
    title: string,
    options?: { channelId?: string | null; modelId?: string | null },
  ) => Promise<Conversation>;
  deleteConversation: (conversationId: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  sendMessage: (
    input: Omit<SendMessageInput, "conversationId">,
  ) => Promise<{ assistantMessageId: string; response: Response }>;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  appendMessageDelta: (messageId: string, delta: string, updates?: Partial<Message>) => void;
  replaceMessages: (messages: Message[]) => void;
  setComposerMode: (mode: ChatMode) => void;
  setSelectedChannelId: (channelId: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  channels: [] as Channel[],
  conversations: [] as Conversation[],
  currentConversation: null as Conversation | null,
  messages: [] as Message[],
  composerMode: "agent" as ChatMode,
  selectedChannelId: null as string | null,
  isLoading: false,
  isStreaming: false,
  error: null as string | null,
};

export function createDesktopChatStore(adapter: ChatAdapter = createChatAdapter()) {
  return create<ChatState>((set, get) => ({
    ...INITIAL_STATE,

    async loadChannels() {
      set({ isLoading: true, error: null });
      try {
        const channels = await adapter.listChannels();
        set((state) => ({
          channels,
          selectedChannelId:
            state.selectedChannelId && channels.some((channel) => channel.id === state.selectedChannelId)
              ? state.selectedChannelId
              : (channels.find((channel) => channel.isDefault)?.id ?? channels[0]?.id ?? null),
          isLoading: false,
        }));
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async loadConversations() {
      set({ isLoading: true, error: null });
      try {
        const conversations = await adapter.listConversations();
        set((state) => {
          const currentConversation = state.currentConversation
            ? conversations.find((conversation) => conversation.id === state.currentConversation?.id) ||
              null
            : null;

          return {
            conversations,
            currentConversation,
            selectedChannelId: currentConversation?.channelId || state.selectedChannelId,
            composerMode: currentConversation?.lastMode || state.composerMode,
            isLoading: false,
          };
        });
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async selectConversation(conversationId) {
      const conversation =
        get().conversations.find((item) => item.id === conversationId) || null;

      set({
        currentConversation: conversation,
        messages: [],
        composerMode: conversation?.lastMode || get().composerMode,
        selectedChannelId: conversation?.channelId || get().selectedChannelId,
      });

      if (!conversation) return;
      await get().loadMessages(conversation.id);
    },

    async createConversation(title, options) {
      const conversation = await adapter.createConversation({
        title,
        channelId: options?.channelId,
        modelId: options?.modelId,
      });

      set((state) => ({
        conversations: [conversation, ...state.conversations],
        currentConversation: conversation,
        messages: [],
        composerMode: conversation.lastMode,
        selectedChannelId: conversation.channelId || state.selectedChannelId,
      }));

      return conversation;
    },

    async deleteConversation(conversationId) {
      await adapter.deleteConversation(conversationId);
      set((state) => ({
        conversations: state.conversations.filter((conversation) => conversation.id !== conversationId),
        currentConversation:
          state.currentConversation?.id === conversationId ? null : state.currentConversation,
        messages: state.currentConversation?.id === conversationId ? [] : state.messages,
      }));
    },

    async loadMessages(conversationId) {
      set({ isLoading: true, error: null });
      try {
        const messages = await adapter.loadMessages(conversationId);
        set({ messages, isLoading: false });
      } catch (error) {
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
    },

    async sendMessage(input) {
      const state = get();
      if (!state.currentConversation) {
        throw new Error("No conversation selected");
      }

      const mode = input.mode || state.composerMode;
      const userMessageId = `draft-user-${crypto.randomUUID()}`;
      const assistantMessageId = `draft-assistant-${crypto.randomUUID()}`;
      const nextMessages = [
        ...state.messages,
        createDraftMessage({
          id: userMessageId,
          conversationId: state.currentConversation.id,
          role: "user",
          content: input.content,
          mode,
          attachments: input.attachments,
        }),
        createDraftMessage({
          id: assistantMessageId,
          conversationId: state.currentConversation.id,
          role: "assistant",
          content: "",
          mode,
        }),
      ];

      set({
        messages: nextMessages,
        isStreaming: true,
        error: null,
      });

      try {
        const response = await adapter.sendMessage({
          conversationId: state.currentConversation.id,
          content: input.content,
          attachments: input.attachments,
          mode,
        });

        return { assistantMessageId, response };
      } catch (error) {
        set({
          isStreaming: false,
          error: toErrorMessage(error),
        });
        throw error;
      }
    },

    updateMessage(messageId, updates) {
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === messageId ? { ...message, ...updates } : message,
        ),
      }));
    },

    appendMessageDelta(messageId, delta, updates) {
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                ...updates,
                content: `${message.content}${delta}`,
              }
            : message,
        ),
      }));
    },

    replaceMessages(messages) {
      set({ messages });
    },

    setComposerMode(mode) {
      set({ composerMode: mode });
    },

    setSelectedChannelId(channelId) {
      set({ selectedChannelId: channelId });
    },

    setStreaming(streaming) {
      set({ isStreaming: streaming });
    },

    setError(error) {
      set({ error });
    },

    reset() {
      set({ ...INITIAL_STATE });
    },
  }));
}

export const useChatStore = createDesktopChatStore();
