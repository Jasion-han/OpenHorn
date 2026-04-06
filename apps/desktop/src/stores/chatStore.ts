import { create } from "zustand";
import { createChatAdapter, type ChatAdapter } from "../lib/chatAdapter";
import type {
  ApiAgentRun,
  ApiCitation,
  ChatStreamEvent,
  Channel,
  ChatMode,
  Conversation,
  Message,
  MessageAttachmentMeta,
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
  attachmentsMeta?: MessageAttachmentMeta[];
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    mode: input.mode,
    attachments: input.attachments,
    attachmentsMeta: input.attachmentsMeta,
    createdAt: new Date(),
  };
}

function createPartialAgentRun(): ApiAgentRun {
  return {
    status: "partial",
    summary: "Thinking",
    steps: [],
  };
}

const STREAM_TAIL_WINDOW = 18;

function getRollingTail(text: string, size = STREAM_TAIL_WINDOW) {
  const chars = Array.from(text);
  return chars.slice(Math.max(0, chars.length - size)).join("");
}

function applyAgentEventToRun(
  run: ApiAgentRun | undefined,
  event: Extract<ChatStreamEvent, { type: "agent_event" }>["event"],
): ApiAgentRun {
  const base = run || createPartialAgentRun();

  if (event.type === "tool_start" || event.type === "tool_result") {
    return {
      ...base,
      summary: "Working",
      steps: [
        ...base.steps,
        {
          type: event.type,
          toolName: event.toolName,
          content: event.content,
          toolInput: event.toolInput,
        },
      ],
    };
  }

  if (event.type === "error") {
    const message = event.content || "Agent error";
    return {
      ...base,
      status: "failed",
      summary: "Error",
      error: message,
      steps: [...base.steps, { type: "error", content: message }],
    };
  }

  return base;
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
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  autoTitleConversation: (
    conversationId: string,
    prompt: string,
  ) => Promise<{ success: boolean; title?: string }>;
  loadMessages: (conversationId: string) => Promise<void>;
  sendMessage: (
    input: Omit<SendMessageInput, "conversationId"> & {
      attachmentsMeta?: MessageAttachmentMeta[];
      existingMessageIds?: { userMessageId: string; assistantMessageId: string };
    },
  ) => Promise<{ userMessageId: string; assistantMessageId: string; response: Response }>;
  addMessage: (message: Message) => void;
  deleteMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (
    messageId: string,
    data?: { userMessageId?: string; userContent?: string },
  ) => Promise<Response>;
  editUserMessage: (messageId: string, content: string) => Promise<Response>;
  abortStreaming: () => void;
  applyStreamEvent: (messageId: string, event: ChatStreamEvent) => void;
  completeStreamingMessage: (messageId: string) => void;
  failStreamingMessage: (messageId: string, error: string) => void;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  appendMessageDelta: (messageId: string, delta: string, updates?: Partial<Message>) => void;
  replaceMessages: (messages: Message[]) => void;
  setComposerMode: (mode: ChatMode) => void;
  setSelectedChannelId: (channelId: string | null) => void;
  setLoading: (loading: boolean) => void;
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
  let selectConversationRequestId = 0;

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

      if (!conversation) {
        set({
          currentConversation: null,
          messages: [],
        });
        return;
      }

      const requestId = ++selectConversationRequestId;
      set({ isLoading: true, error: null });

      try {
        const messages = await adapter.loadMessages(conversation.id);
        if (requestId !== selectConversationRequestId) return;

        set((state) => ({
          currentConversation: conversation,
          messages,
          composerMode: conversation.lastMode || state.composerMode,
          selectedChannelId: conversation.channelId || state.selectedChannelId,
          isLoading: false,
        }));
      } catch (error) {
        if (requestId !== selectConversationRequestId) return;
        set({ isLoading: false, error: toErrorMessage(error) });
        throw error;
      }
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

    async updateConversation(conversationId, updates) {
      const state = get();
      const previous = state.conversations.find((conversation) => conversation.id === conversationId) || null;

      set((nextState) => ({
        conversations: nextState.conversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, ...updates } : conversation,
        ),
        currentConversation:
          nextState.currentConversation?.id === conversationId
            ? { ...nextState.currentConversation, ...updates }
            : nextState.currentConversation,
        selectedChannelId:
          nextState.currentConversation?.id === conversationId && updates.channelId !== undefined
            ? updates.channelId || null
            : nextState.selectedChannelId,
      }));

      try {
        await adapter.updateConversation(conversationId, {
          title: updates.title,
          channelId: updates.channelId,
          modelId: updates.modelId,
          systemPrompt: updates.systemPrompt,
          contextLength: updates.contextLength,
          isPinned: updates.isPinned,
          forceWebSearch: updates.forceWebSearch,
        });
      } catch (error) {
        if (previous) {
          set((nextState) => ({
            conversations: nextState.conversations.map((conversation) =>
              conversation.id === conversationId ? previous : conversation,
            ),
            currentConversation:
              nextState.currentConversation?.id === conversationId
                ? previous
                : nextState.currentConversation,
            selectedChannelId:
              nextState.currentConversation?.id === conversationId
                ? previous.channelId || null
                : nextState.selectedChannelId,
            error: toErrorMessage(error),
          }));
        } else {
          set({ error: toErrorMessage(error) });
        }
        throw error;
      }
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

    async autoTitleConversation(conversationId, prompt) {
      const result = await adapter.autoTitleConversation(conversationId, prompt);
      if (!result.success || !result.title) {
        return result;
      }

      const nextUpdatedAt = new Date();
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, title: result.title!, updatedAt: nextUpdatedAt }
            : conversation,
        ),
        currentConversation:
          state.currentConversation?.id === conversationId
            ? { ...state.currentConversation, title: result.title!, updatedAt: nextUpdatedAt }
            : state.currentConversation,
      }));

      return result;
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
      const userMessageId =
        input.existingMessageIds?.userMessageId || `draft-user-${crypto.randomUUID()}`;
      const assistantMessageId =
        input.existingMessageIds?.assistantMessageId || `draft-assistant-${crypto.randomUUID()}`;
      const nextMessages = input.existingMessageIds
        ? state.messages
        : [
            ...state.messages,
            createDraftMessage({
              id: userMessageId,
              conversationId: state.currentConversation.id,
              role: "user",
              content: input.content,
              mode,
              attachments: input.attachments,
              attachmentsMeta: input.attachmentsMeta,
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

        return { userMessageId, assistantMessageId, response };
      } catch (error) {
        if (input.existingMessageIds) {
          set({
            isStreaming: false,
            error: toErrorMessage(error),
          });
        } else {
          set({
            messages: state.messages,
            isStreaming: false,
            error: toErrorMessage(error),
          });
        }
        throw error;
      }
    },

    addMessage(message) {
      set((state) => ({
        messages: [...state.messages, message],
      }));
    },

    async deleteMessage(messageId) {
      await adapter.deleteMessage(messageId);
      set((state) => ({
        messages: state.messages.filter((message) => message.id !== messageId),
      }));
    },

    async regenerateMessage(messageId, data) {
      return adapter.regenerateMessage(messageId, data);
    },

    async editUserMessage(messageId, content) {
      return adapter.editUserMessage(messageId, content);
    },

    abortStreaming() {
      adapter.abortActiveStream();
      set({ isStreaming: false });
    },

    applyStreamEvent(messageId, event) {
      if (event.type === "delta") {
        get().appendMessageDelta(messageId, event.content || "");
        return;
      }

      if (event.type === "live_status") {
        get().updateMessage(messageId, {
          liveStatus: event.status,
          liveRoute: event.route,
          liveLabel: event.label,
        });
        return;
      }

      if (event.type === "citations") {
        get().updateMessage(messageId, {
          citations: event.citations as ApiCitation[],
        });
        return;
      }

      if (event.type === "agent_event") {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  agentRun: applyAgentEventToRun(message.agentRun, event.event),
                }
              : message,
          ),
        }));
        return;
      }

      if (event.type === "done") {
        get().updateMessage(messageId, {
          id: event.messageId || messageId,
          model: event.model,
          agentRun: event.agentRun,
        });
        get().completeStreamingMessage(event.messageId || messageId);
        return;
      }

      if (event.type === "error") {
        get().failStreamingMessage(messageId, event.message || "Stream error");
      }
    },

    completeStreamingMessage(_messageId) {
      set({ isStreaming: false });
    },

    failStreamingMessage(messageId, error) {
      set((state) => ({
        isStreaming: false,
        error,
        messages: state.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                content: message.content || error,
                agentRun: message.agentRun
                  ? {
                      ...message.agentRun,
                      status: "failed",
                      summary: "Error",
                      error,
                    }
                  : message.agentRun,
              }
            : message,
        ),
      }));
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
                streamTail: getRollingTail(`${message.content}${delta}`),
                streamPulseKey: (message.streamPulseKey ?? 0) + 1,
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

    setLoading(loading) {
      set({ isLoading: loading });
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
