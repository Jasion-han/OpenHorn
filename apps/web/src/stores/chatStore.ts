import { create } from 'zustand';
import { api, type ApiAgentRun, type ApiChannel, type ApiCitation, type ApiConversation, type ApiLiveMetadata, type ApiLiveRoute, type ApiLiveStatus, type ApiMessage } from '../lib/api';

export type Channel = ApiChannel;

export interface Conversation {
  id: string;
  title: string;
  channelId?: string;
  modelId?: string;
  systemPrompt?: string;
  contextLength: number;
  defaultMode: 'chat' | 'agent';
  lastMode: 'chat' | 'agent';
  isPinned: boolean;
  runStatus?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  mode: 'chat' | 'agent';
  attachments?: string[];
  agentRun?: ApiAgentRun;
  attachmentsMeta?: Array<{
    id?: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    previewUrl?: string;
  }>;
  liveStatus?: ApiLiveStatus;
  liveRoute?: ApiLiveRoute;
  liveLabel?: string;
  citations?: ApiCitation[];
  streamTail?: string;
  streamPulseKey?: number;
  createdAt: Date;
}

const STREAM_TAIL_WINDOW = 18;

function getRollingTail(text: string, size = STREAM_TAIL_WINDOW) {
  const chars = Array.from(text);
  return chars.slice(Math.max(0, chars.length - size)).join('');
}

function parseConversation(conv: ApiConversation): Conversation {
  return {
    id: conv.id,
    title: conv.title,
    channelId: conv.channelId || undefined,
    modelId: conv.modelId || undefined,
    systemPrompt: conv.systemPrompt || undefined,
    contextLength: conv.contextLength ?? 4096,
    defaultMode: conv.defaultMode === 'chat' ? 'chat' : 'agent',
    lastMode: conv.lastMode === 'chat' ? 'chat' : 'agent',
    isPinned: Boolean(conv.isPinned),
    runStatus: conv.runStatus ?? null,
    createdAt: new Date(conv.createdAt),
    updatedAt: new Date(conv.updatedAt),
  };
}

function parseMessage(msg: ApiMessage): Message {
  let attachmentIds: string[] | undefined;
  if (msg.attachments) {
    try {
      attachmentIds = JSON.parse(msg.attachments) as string[];
    } catch {
      attachmentIds = undefined;
    }
  }

  let liveMetadata: ApiLiveMetadata | undefined;
  if (msg.liveMetadata) {
    try {
      liveMetadata = JSON.parse(msg.liveMetadata) as ApiLiveMetadata;
    } catch {
      liveMetadata = undefined;
    }
  }

  let citations: ApiCitation[] | undefined;
  if (msg.citations) {
    try {
      citations = JSON.parse(msg.citations) as ApiCitation[];
    } catch {
      citations = undefined;
    }
  }

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    role: msg.role,
    content: msg.content,
    model: msg.model || undefined,
    mode: msg.mode === 'chat' ? 'chat' : 'agent',
    attachments: attachmentIds,
    agentRun: (() => {
      if (!msg.agentRun) return undefined;
      try {
        return JSON.parse(msg.agentRun) as ApiAgentRun;
      } catch {
        return undefined;
      }
    })(),
    attachmentsMeta: (msg.attachmentsMeta || undefined) as any,
    liveStatus: liveMetadata?.status,
    liveRoute: liveMetadata?.route,
    liveLabel: liveMetadata?.label,
    citations,
    createdAt: new Date(msg.createdAt),
  };
}

interface ChatState {
  channels: Channel[];
  conversations: Conversation[];
  currentConversation: Conversation | null;
  messages: Message[];
  composerMode: 'chat' | 'agent';
  selectedChannelId: string | null;
  isLoading: boolean;
  isStreaming: boolean;
  
  setChannels: (channels: Channel[]) => void;
  addChannel: (channel: Channel) => void;
  removeChannel: (id: string) => void;
  
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  removeConversation: (id: string) => void;
  setCurrentConversation: (conversation: Conversation | null) => void;
  loadConversations: () => Promise<void>;
  createConversation: (title: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  setConversationModel: (conversationId: string, channelId: string | null, modelId: string | null) => Promise<void>;
  
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, content: string, updates?: Partial<Message>) => void;
  appendMessageDelta: (id: string, delta: string, updates?: Partial<Message>) => void;
  deleteMessage: (id: string) => Promise<void>;
  
  setComposerMode: (mode: 'chat' | 'agent') => void;
  setSelectedChannelId: (id: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setIsStreaming: (streaming: boolean) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  channels: [],
  conversations: [],
  currentConversation: null,
  messages: [],
  composerMode: 'agent',
  selectedChannelId: null,
  isLoading: false,
  isStreaming: false,
  
  setChannels: (channels) => set({ channels }),
  addChannel: (channel) => set((state) => ({ 
    channels: [...state.channels, channel] 
  })),
  removeChannel: (id) => set((state) => ({ 
    channels: state.channels.filter((c) => c.id !== id) 
  })),
  
  setConversations: (conversations) => set({ conversations }),
  addConversation: (conversation) => set((state) => ({ 
    conversations: [conversation, ...state.conversations] 
  })),
  updateConversation: (id, updates) => set((state) => ({
    conversations: state.conversations.map((c) => 
      c.id === id ? { ...c, ...updates } : c
    ),
    currentConversation: state.currentConversation?.id === id 
      ? { ...state.currentConversation, ...updates }
      : state.currentConversation,
  })),
  removeConversation: (id) => set((state) => ({ 
    conversations: state.conversations.filter((c) => c.id !== id),
    currentConversation: state.currentConversation?.id === id 
      ? null 
      : state.currentConversation,
  })),
  setCurrentConversation: (conversation) => set({ 
    currentConversation: conversation,
    messages: [],
  }),
  
  loadConversations: async () => {
    try {
      const { conversations } = await api.conversations.list();
      set({ conversations: conversations.map(parseConversation) });
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  },
  
  createConversation: async (title: string) => {
    const { conversation } = await api.conversations.create({ title });
    const newConv = parseConversation(conversation);
    set((state) => ({ 
      conversations: [newConv, ...state.conversations] 
    }));
    return newConv;
  },
  
  deleteConversation: async (id: string) => {
    await api.conversations.delete(id);
    set((state) => ({ 
      conversations: state.conversations.filter((c) => c.id !== id),
      currentConversation: state.currentConversation?.id === id 
        ? null 
        : state.currentConversation,
    }));
  },

  loadMessages: async (conversationId: string) => {
    const { messages } = await api.messages.list(conversationId);
    set({ messages: messages.map(parseMessage) });
  },

  setConversationModel: async (conversationId: string, channelId: string | null, modelId: string | null) => {
    const state = get();
    const existing = state.conversations.find((c) => c.id === conversationId) || null;
    const prev = existing ? { channelId: existing.channelId, modelId: existing.modelId } : null;

    set((s) => ({
      conversations: s.conversations.map((c) => (
        c.id === conversationId ? { ...c, channelId: channelId || undefined, modelId: modelId || undefined } : c
      )),
      currentConversation: s.currentConversation?.id === conversationId
        ? { ...s.currentConversation, channelId: channelId || undefined, modelId: modelId || undefined }
        : s.currentConversation,
    }));

    try {
      await api.conversations.update(conversationId, { channelId, modelId });
    } catch (error) {
      // rollback best-effort
      if (prev) {
        set((s) => ({
          conversations: s.conversations.map((c) => (
            c.id === conversationId ? { ...c, channelId: prev.channelId, modelId: prev.modelId } : c
          )),
          currentConversation: s.currentConversation?.id === conversationId
            ? { ...s.currentConversation, channelId: prev.channelId, modelId: prev.modelId }
            : s.currentConversation,
        }));
      }
      throw error;
    }
  },
  
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),
  appendMessageDelta: (id, delta, updates) => set((state) => ({
    messages: state.messages.map((message) =>
      message.id === id
        ? {
            ...message,
            content: `${message.content || ''}${delta}`,
            streamTail: getRollingTail(`${message.content || ''}${delta}`),
            streamPulseKey: (message.streamPulseKey ?? 0) + 1,
            ...updates,
          }
        : message
    ),
  })),
  deleteMessage: async (id: string) => {
    await api.messages.delete(id);
    set((state) => ({ messages: state.messages.filter((m) => m.id !== id) }));
  },
  updateMessage: (id, content, updates) => set((state) => ({
    messages: state.messages.map((m) => 
      m.id === id ? { ...m, content, ...updates } : m
    ),
  })),
  
  setComposerMode: (mode) => set({ composerMode: mode }),
  setSelectedChannelId: (id) => set({ selectedChannelId: id }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
}));
