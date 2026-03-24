import { Paperclip, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "ui";

function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function truncateName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

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

  useEffect(() => {
    if (!isImage(file.type)) {
      setPreviewUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  if (isImage(file.type) && previewUrl) {
    return (
      <div
        className={cn(
          "group/attachment relative size-[72px] shrink-0 overflow-hidden rounded-lg",
          className,
        )}
      >
        <img src={previewUrl} alt={file.name} className="size-full object-cover" />
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            "absolute right-1 top-1 flex size-[18px] items-center justify-center rounded-full",
            "bg-black/50 text-white backdrop-blur-sm",
            "opacity-0 transition-opacity duration-200 group-hover/attachment:opacity-100",
            "hover:bg-black/70",
          )}
          aria-label="移除附件"
          title="移除附件"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/attachment relative flex shrink-0 items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10 py-1.5 pl-2.5 pr-7 text-[13px] text-[#37a5aa]",
        "transition-colors hover:bg-[#37a5aa]/15",
        className,
      )}
    >
      <Paperclip className="size-4 shrink-0" />
      <span className="max-w-[160px] truncate">{truncateName(file.name)}</span>
      <button
        type="button"
        onClick={onRemove}
        className={cn(
          "absolute right-1.5 top-1/2 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full",
          "text-[#37a5aa]/60 transition-all duration-200 hover:bg-[#37a5aa]/20 hover:text-[#37a5aa]",
          "opacity-0 group-hover/attachment:opacity-100",
        )}
        aria-label="移除附件"
        title="移除附件"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
