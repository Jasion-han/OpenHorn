import { useCallback } from 'react';
import { useChatStore, type Message, type Conversation } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { streamChatMessage } from '../lib/chat-stream';

export function useChat() {
  const { user } = useAuthStore();
  const {
    channels,
    conversations,
    currentConversation,
    messages,
    selectedChannelId,
    isLoading,
    isStreaming,
    setChannels,
    setConversations,
    setCurrentConversation,
    setMessages,
    addMessage,
    updateMessage,
    setIsLoading,
    setIsStreaming,
  } = useChatStore();
  
  const loadChannels = useCallback(async () => {
    if (!user) return;
    try {
      const { channels } = await api.channels.list();
      setChannels(channels as never[]);
    } catch (error) {
      console.error('Failed to load channels:', error);
    }
  }, [user, setChannels]);
  
  const loadConversations = useCallback(async () => {
    if (!user) return;
    try {
      const { conversations } = await api.conversations.list();
      setConversations(conversations as never[]);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  }, [user, setConversations]);
  
  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const { messages } = await api.messages.list(conversationId);
      setMessages(messages as never[]);
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  }, [setMessages]);
  
  const createConversation = useCallback(async (title: string, channelId?: string) => {
    try {
      const { conversation } = await api.conversations.create({ title, channelId });
      setCurrentConversation(conversation as Conversation);
      setMessages([]);
      await loadConversations();
      return conversation as Conversation;
    } catch (error) {
      console.error('Failed to create conversation:', error);
      throw error;
    }
  }, [setCurrentConversation, setMessages, loadConversations]);
  
  const sendMessage = useCallback(async (content: string) => {
    if (!currentConversation) return;
    
    setIsLoading(true);
    setIsStreaming(true);
    
    try {
      const tempAssistantId = `temp-assistant-${Date.now()}`;
      let assistantContent = '';

      addMessage({
        id: tempAssistantId,
        conversationId: currentConversation.id,
        role: 'assistant',
        content: '',
        createdAt: new Date(),
      } as Message);

      await streamChatMessage(
        { conversationId: currentConversation.id, content },
        {
          onDelta: (chunk) => {
            if (!chunk) return;
            assistantContent += chunk;
            updateMessage(tempAssistantId, assistantContent);
          },
          onDone: async () => {
            const { messages } = await api.messages.list(currentConversation.id);
            setMessages(messages as Message[]);
          },
          onError: (message) => {
            updateMessage(tempAssistantId, `Error: ${message}`);
          },
        }
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  }, [currentConversation, addMessage, setIsLoading, setIsStreaming, setMessages, updateMessage]);
  
  const selectConversation = useCallback(async (conversation: Conversation) => {
    setCurrentConversation(conversation);
    await loadMessages(conversation.id);
  }, [setCurrentConversation, loadMessages]);
  
  const deleteConversation = useCallback(async (id: string) => {
    try {
      await api.conversations.delete(id);
      await loadConversations();
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      throw error;
    }
  }, [loadConversations]);
  
  return {
    channels,
    conversations,
    currentConversation,
    messages,
    selectedChannelId,
    isLoading,
    isStreaming,
    loadChannels,
    loadConversations,
    loadMessages,
    createConversation,
    sendMessage,
    selectConversation,
    deleteConversation,
  };
}
