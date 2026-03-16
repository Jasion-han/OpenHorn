'use client';

import { useChatStore } from '@/stores/chatStore';

export function ChatHeader() {
  const { currentConversation } = useChatStore();

  if (!currentConversation) {
    return (
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold">会话</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between mb-3 gap-2">
      <div className="min-w-0">
        <p className="font-semibold truncate">{currentConversation.title}</p>
      </div>
    </div>
  );
}
