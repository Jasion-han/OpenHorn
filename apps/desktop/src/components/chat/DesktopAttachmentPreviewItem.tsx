import { Paperclip, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { truncateName } from "shared/format";
import { cn } from "ui";
import { attachmentKind } from "../../lib/attachmentPreview";
import { getChatLabel } from "../../lib/i18n/agent";
import { usePreviewPanelStore } from "../../stores/previewPanelStore";

export function DesktopAttachmentPreviewItem({
  file,
  onRemove,
  className,
}: {
  file: File;
  onRemove: () => void;
  className?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const openAttachment = usePreviewPanelStore((state) => state.openAttachment);
  const attachments = useMemo(
    () => [{ fileName: file.name, fileType: file.type, fileSize: file.size }],
    [file],
  );
  const image = attachmentKind(attachments[0]) === "image";
  useEffect(() => {
    if (!image) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, image]);
  return (
    <div className={cn("group/attachment relative inline-flex shrink-0", className)}>
      <button
        type="button"
        onClick={() => openAttachment({ attachments, index: 0, file })}
        title={file.name}
        aria-label={`${getChatLabel("chat.attachment.preview")}: ${file.name}`}
        className={cn(
          "cursor-pointer rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          image && previewUrl
            ? "block size-[72px] overflow-hidden"
            : "flex max-w-[240px] items-center gap-2 border border-[#37a5aa]/20 bg-[#37a5aa]/10 py-2 pl-2.5 pr-8 text-[13px] text-[#37a5aa] hover:bg-[#37a5aa]/15",
        )}
      >
        {image && previewUrl ? (
          <img src={previewUrl} alt={file.name} className="size-full object-cover" />
        ) : (
          <>
            <Paperclip aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{truncateName(file.name)}</span>
          </>
        )}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={getChatLabel("chat.attachment.remove")}
        title={getChatLabel("chat.attachment.remove")}
        className={cn(
          "absolute right-0.5 top-0.5 flex size-6 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          image
            ? "bg-black/60 text-white hover:bg-black/80"
            : "text-[#37a5aa] hover:bg-[#37a5aa]/20",
        )}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
