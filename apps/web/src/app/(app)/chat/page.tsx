'use client';

import { ChatAside } from '@/components/chat/ChatAside';
import { ChatArea } from '@/components/ChatArea';
import { AppShellSlot } from '@/components/app/AppShellSlot';

export default function ChatPage() {
  return (
    <>
      <AppShellSlot title="Chat" aside={<ChatAside />} />
      {/* Full-bleed: cancel AppShell.Main padding so chat can reach the bottom edge. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          margin: 'calc(var(--mantine-spacing-md) * -1)',
        }}
      >
        <ChatArea />
      </div>
    </>
  );
}
