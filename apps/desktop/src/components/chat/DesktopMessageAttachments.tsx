import { Paperclip } from "lucide-react";
import { useRef } from "react";
import { truncateName } from "shared/format";
import { cn } from "ui";
import { attachmentKind } from "../../lib/attachmentPreview";
import { getAttachmentUrl } from "../../lib/attachmentUrl";
import { type ChatScrollAnchor, captureAttachmentScrollAnchor } from "../../lib/chatScrollAnchor";
import { getChatLabel } from "../../lib/i18n/agent";
import { usePreviewPanelStore } from "../../stores/previewPanelStore";
import type { MessageAttachmentMeta } from "../../types/chat";

export function DesktopMessageAttachments({
  attachments,
  className,
}: {
  attachments: MessageAttachmentMeta[];
  className?: string;
}) {
  const pointerAnchor = useRef<{ index: number; anchor?: ChatScrollAnchor } | null>(null);
  const openAttachment = usePreviewPanelStore((state) => state.openAttachment);
  if (!attachments?.length) return null;
  const imageCount = attachments.filter((att) => attachmentKind(att) === "image").length;
  return (
    <div className={cn("mb-2 flex flex-wrap items-start gap-2", className)}>
      {attachments.map((att, index) => {
        const image = attachmentKind(att) === "image";
        const src = att.previewUrl || (att.id ? getAttachmentUrl(att.id) : null);
        return (
          <button
            key={att.id || `${att.fileName}-${index}`}
            type="button"
            onPointerDown={(event) => {
              if (event.button === 0)
                pointerAnchor.current = {
                  index,
                  anchor: captureAttachmentScrollAnchor(event.currentTarget, index),
                };
            }}
            onPointerCancel={() => {
              pointerAnchor.current = null;
            }}
            onClick={(event) => {
              // Capture before the browser's default focus scroll can move a long round.
              const captured = pointerAnchor.current;
              pointerAnchor.current = null;
              openAttachment({
                attachments,
                index,
                returnAnchor:
                  event.detail > 0 && captured?.index === index
                    ? captured.anchor
                    : captureAttachmentScrollAnchor(event.currentTarget, index),
              });
            }}
            data-chat-attachment-index={index}
            title={att.fileName}
            aria-label={`${getChatLabel("chat.attachment.preview")}: ${att.fileName}`}
            className={cn(
              "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              image && src
                ? cn(
                    "relative shrink-0 overflow-hidden rounded-lg transition-opacity hover:opacity-90",
                    imageCount === 1 && attachments.length === 1
                      ? "h-[200px] w-[min(280px,100%)]"
                      : "size-[min(280px,70vw)]",
                  )
                : "flex max-w-full items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10 px-3 py-1.5 text-[13px] text-[#37a5aa] transition-colors hover:bg-[#37a5aa]/15",
            )}
          >
            {image && src ? (
              <img
                src={src}
                alt={att.fileName}
                className={cn(
                  "size-full bg-muted/10",
                  imageCount === 1 ? "object-contain" : "object-cover",
                )}
              />
            ) : (
              <>
                <Paperclip aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{truncateName(att.fileName)}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
