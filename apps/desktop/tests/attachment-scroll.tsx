import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopMarkdownMessage } from "../src/components/chat/DesktopMarkdownMessage";
import { DesktopMessageAttachments } from "../src/components/chat/DesktopMessageAttachments";
import { DesktopUserMessageContent } from "../src/components/chat/DesktopUserMessageContent";
import { DesktopPreviewPanel } from "../src/components/preview/DesktopPreviewPanel";
import { useChatPreviewScrollAnchor } from "../src/hooks/useChatPreviewScrollAnchor";
import { usePreviewPanelStore } from "../src/stores/previewPanelStore";
import "../src/styles/globals.css";

const rounds = Array.from({ length: 130 }, (_, index) => ({
  key: `round-${index}`,
  message: `message-${index}`,
}));
const query = new URLSearchParams(window.location.search);
const attachment = [
  {
    fileName: query.get("file") ?? "anchor.txt",
    fileType: query.get("mime") ?? undefined,
    previewUrl:
      query.get("url") ??
      URL.createObjectURL(new Blob(["Original attachment"], { type: "text/plain" })),
  },
];

function Fixture() {
  const viewport = useRef<HTMLDivElement>(null);
  const [conversation, setConversation] = useState("conversation-one");
  const [tall, setTall] = useState(false);
  const [explicitTarget, setExplicitTarget] = useState<number | null>(null);
  const panel = usePreviewPanelStore();
  // Programmatic test navigation needs its target mounted while estimates settle.
  // Release that preparation pin as soon as the actual preview anchor takes over.
  useEffect(() => {
    if (panel.isOpen) setExplicitTarget(null);
  }, [panel.isOpen]);
  const getKey = useCallback((index: number) => rounds[index].key, []);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const anchor = useChatPreviewScrollAnchor({
    viewportRef: viewport,
    virtualizerRef,
    conversationId: conversation,
    findRoundIndex: (key) => rounds.findIndex((round) => round.key === key),
  });
  const virtualizer = useVirtualizer({
    count: rounds.length,
    getScrollElement: () => viewport.current,
    getItemKey: getKey,
    estimateSize: () => 120,
    overscan: 6,
    useFlushSync: false,
    rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      const pinned = rounds.findIndex((round) => round.key === anchor.pinnedRoundKey);
      if (pinned >= 0) indexes.add(pinned);
      if (explicitTarget !== null) indexes.add(explicitTarget);
      return [...indexes].sort((a, b) => a - b);
    },
  });
  virtualizerRef.current = virtualizer;
  Object.assign(window, { attachmentScrollVirtualizer: virtualizer });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (anchor.restoringRef.current) return false;
    const offset = instance.scrollOffset ?? 0;
    if (!instance.itemSizeCache.has(item.key)) return item.start < offset;
    if (instance.scrollDirection === "backward") return false;
    return item.end <= offset;
  };
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <main
        style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%" }}
      >
        <div className="flex gap-4 border-b p-3">
          <button
            type="button"
            onClick={() => {
              setExplicitTarget(55);
              queueMicrotask(() => virtualizer.scrollToIndex(55, { align: "start" }));
            }}
          >
            Locate round
          </button>
          <button
            type="button"
            onClick={() => {
              anchor.cancel();
              setExplicitTarget(rounds.length - 1);
              queueMicrotask(() => virtualizer.scrollToIndex(rounds.length - 1, { align: "end" }));
            }}
          >
            Jump latest
          </button>
          <button type="button" onClick={() => setTall((v) => !v)}>
            Delayed height
          </button>
          <button
            type="button"
            onClick={() =>
              setConversation((v) =>
                v === "conversation-one" ? "conversation-two" : "conversation-one",
              )
            }
          >
            Switch conversation
          </button>
          {panel.collapsed && (
            <button type="button" onClick={panel.expandPanel}>
              Expand preview
            </button>
          )}
        </div>
        <div
          ref={viewport}
          data-chat-scroll-viewport
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "scroll",
            overflowAnchor: "none",
            padding: "0 20px",
          }}
        >
          <div>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((row) => (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  data-chat-round-key={rounds[row.index].key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                    paddingBottom: 24,
                  }}
                >
                  <article
                    data-chat-message-key={rounds[row.index].message}
                    data-chat-conversation-id={conversation}
                  >
                    <p>
                      {row.index}:{" "}
                      {"Long message changes height when the attachment sidebar opens. ".repeat(
                        row.index === 55 ? 130 : 4 + (row.index % 12),
                      )}
                    </p>
                    {row.index === 55 && <div style={{ height: tall ? 360 : 0 }} />}
                    {query.has("path") ? (
                      <DesktopMarkdownMessage content={`Created \`${query.get("path")}\``} />
                    ) : query.has("link") ? (
                      <DesktopUserMessageContent content={`Read ${query.get("link")}`} />
                    ) : (
                      <DesktopMessageAttachments attachments={attachment} />
                    )}
                    <p>{"Answer after attachment. ".repeat(8 + (row.index % 7))}</p>
                  </article>
                </div>
              ))}
            </div>
          </div>
        </div>
        <textarea aria-label="Chat draft" style={{ height: 70, flexShrink: 0 }} />
      </main>
      {panel.isOpen && <DesktopPreviewPanel collapsed={panel.collapsed} />}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
