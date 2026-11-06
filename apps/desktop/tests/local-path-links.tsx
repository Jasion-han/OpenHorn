import { createRoot } from "react-dom/client";
import { MessageBubble } from "../src/components/chat/DesktopMessageBubble";
import { DesktopPreviewPanel } from "../src/components/preview/DesktopPreviewPanel";
import { usePreviewPanelStore } from "../src/stores/previewPanelStore";
import type { Message } from "../src/types/chat";
import "../src/styles/globals.css";
const source =
  "Created `/fixture/notes.txt`, missing `/fixture/deleted.txt`, folder `/fixture/folder`, large `/fixture/large.pdf`.\n\nOrdinary `/bin/ls -la` and `value = 42`.\n\n```sh\n/fixture/notes.txt\n```\n\n```\n/fixture/notes.txt\n```\n\n[Explicit code link](/fixture/notes.txt) and [`/fixture/notes.txt`](https://example.test/).";
const message: Message = {
  id: "assistant",
  conversationId: "conversation",
  role: "assistant",
  content: source,
  mode: "chat",
  createdAt: new Date(),
};
function Fixture() {
  const panel = usePreviewPanelStore();
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <main style={{ flex: 1, minWidth: 0, padding: 16 }}>
        <MessageBubble
          message={message}
          isStreaming={false}
          canEdit={false}
          canRetry={false}
          canDelete={false}
          onEdit={() => {}}
          onRetry={() => {}}
          onDelete={() => {}}
          assistantWidth="100%"
          userMaxWidth="90%"
        />
        <textarea aria-label="Chat draft" />
      </main>
      {panel.isOpen && <DesktopPreviewPanel collapsed={panel.collapsed} />}
    </div>
  );
}
const node = document.getElementById("root");
if (!node) throw new Error("Missing root");
createRoot(node).render(<Fixture />);
