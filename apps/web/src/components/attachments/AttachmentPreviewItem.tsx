"use client";

import { Paperclip, X } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function truncateName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

export function AttachmentPreviewItem(props: {
  filename: string;
  mediaType: string;
  previewUrl?: string;
  onRemove: () => void;
  className?: string;
}): React.ReactElement {
  const { filename, mediaType, previewUrl, onRemove, className } = props;

  if (isImage(mediaType) && previewUrl) {
    return (
      <div
        className={cn(
          "group/attachment relative size-[72px] shrink-0 overflow-hidden rounded-lg",
          className,
        )}
      >
        {/* biome-ignore lint/performance/noImgElement: previewUrl can be blob/object URL; Next Image isn't suitable here */}
        <img src={previewUrl} alt={filename} className="size-full object-cover" />
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            "absolute right-1 top-1 size-[18px] rounded-full",
            "bg-black/50 text-white backdrop-blur-sm",
            "flex items-center justify-center",
            "opacity-0 transition-opacity duration-200 group-hover/attachment:opacity-100",
            "hover:bg-black/70",
          )}
          aria-label="Remove attachment"
          title="Remove"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/attachment relative flex shrink-0 items-center gap-2",
        "rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10",
        "pl-2.5 pr-7 py-1.5 text-[13px] text-[#37a5aa]",
        "transition-colors hover:bg-[#37a5aa]/15",
        className,
      )}
    >
      <Paperclip className="size-4 shrink-0" />
      <span className="max-w-[160px] truncate">{truncateName(filename)}</span>
      <button
        type="button"
        onClick={onRemove}
        className={cn(
          "absolute right-1.5 top-1/2 -translate-y-1/2 size-[18px] rounded-full",
          "flex items-center justify-center",
          "text-[#37a5aa]/60 hover:text-[#37a5aa] hover:bg-[#37a5aa]/20",
          "opacity-0 transition-all duration-200 group-hover/attachment:opacity-100",
        )}
        aria-label="Remove attachment"
        title="Remove"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
