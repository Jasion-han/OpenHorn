import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageBubble } from "../src/components/chat/DesktopMessageBubble";
import { DesktopPreviewPanel } from "../src/components/preview/DesktopPreviewPanel";
import { usePreviewPanelStore } from "../src/stores/previewPanelStore";
import type { Message } from "../src/types/chat";
import "../src/styles/globals.css";
const source =
  "/web-access 看这里：https://example.test/a_(b)?x=1&y=2，\n第二个：https://other.test/docs。\n原文 **不转换** <tag> `code`\n长链接：https://long.test/" +
  "part".repeat(90);
Object.assign(window, { userLinkSource: source, linkEscapedClicks: 0 });
document.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("a[href]"))
    Object.assign(window, {
      linkEscapedClicks: (window as unknown as { linkEscapedClicks: number }).linkEscapedClicks + 1,
    });
});
const message: Message = {
  id: "user-one",
  conversationId: "conversation",
  role: "user",
  content: source,
  mode: "agent",
  createdAt: new Date("2026-11-06T00:00:00Z"),
};
const commands = new Map([["web-access", "skill"]] as const);
function Fixture() {
  const panel = usePreviewPanelStore();
  const [reloaded, setReloaded] = useState(false);
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <main style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20 }}>
        <button type="button" onClick={() => setReloaded((v) => !v)}>
          Reload messages
        </button>
        <section aria-label="User bubble">
          <MessageBubble
            message={reloaded ? { ...message } : message}
            isStreaming={false}
            canEdit={false}
            canRetry={false}
            canDelete={false}
            onEdit={() => {}}
            onRetry={() => {}}
            onDelete={() => {}}
            assistantWidth="100%"
            userMaxWidth="90%"
            knownCommands={commands}
          />
        </section>
        <textarea aria-label="Chat draft" />
      </main>
      {panel.isOpen && <DesktopPreviewPanel collapsed={panel.collapsed} />}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
