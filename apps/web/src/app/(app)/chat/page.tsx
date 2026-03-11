'use client';

import { ChatAside } from '@/components/chat/ChatAside';
import { ChatArea } from '@/components/ChatArea';
import { AppShellSlot } from '@/components/app/AppShellSlot';

export default function ChatPage() {
  return (
    <>
      <AppShellSlot title="Chat" aside={<ChatAside />} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ChatArea />
      </div>
    </>
  );
}
