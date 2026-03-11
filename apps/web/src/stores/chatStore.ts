import { create } from 'zustand';
import { api, type ApiChannel } from '../lib/api';

export type Channel = ApiChannel;

export interface Conversation {
  id: string;
  title: string;
  channelId?: string;
  systemPrompt?: string;
  contextLength: number;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  createdAt: Date;
}

interface ChatState {
  channels: Channel[];
  conversations: Conversation[];
  currentConversation: Conversation | null;
  messages: Message[];
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
  
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, content: string) => void;
  
  setSelectedChannelId: (id: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setIsStreaming: (streaming: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  channels: [],
  conversations: [],
  currentConversation: null,
  messages: [],
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
      set({ conversations: conversations as Conversation[] });
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  },
  
  createConversation: async (title: string) => {
    const { conversation } = await api.conversations.create({ title });
    const newConv = conversation as Conversation;
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
  
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ 
    messages: [...state.messages, message] 
  })),
  updateMessage: (id, content) => set((state) => ({
    messages: state.messages.map((m) => 
      m.id === id ? { ...m, content } : m
    ),
  })),
  
  setSelectedChannelId: (id) => set({ selectedChannelId: id }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
}));
