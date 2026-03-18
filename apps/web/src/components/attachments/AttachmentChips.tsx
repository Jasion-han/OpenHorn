"use client";

import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type AttachmentChipItem = {
  id?: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
};

function pickIcon(fileType?: string) {
  if (fileType?.startsWith("image/")) return ImageIcon;
  if (fileType?.startsWith("text/") || fileType === "application/pdf") return FileText;
  return Paperclip;
}

export function AttachmentChips(props: { items: AttachmentChipItem[]; className?: string }) {
  const { items, className } = props;
  if (!items || items.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {items.map((item, idx) => {
        const Icon = pickIcon(item.fileType);
        return (
          <Badge
            key={item.id || `${item.fileName}-${idx}`}
            variant="secondary"
            className="max-w-[280px] truncate"
            title={item.fileName}
          >
            <Icon className="size-3.5 opacity-70" />
            <span className="truncate">{item.fileName}</span>
          </Badge>
        );
      })}
    </div>
  );
}
