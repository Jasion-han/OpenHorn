import { ChevronLeft, ChevronRight, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { truncateName } from "shared/format";
import { cn, Dialog, DialogClose, DialogContent, DialogDescription } from "ui";
import { getAttachmentUrl } from "../../lib/attachmentUrl";
import { getChatLabel } from "../../lib/i18n/agent";
import type { MessageAttachmentMeta } from "../../types/chat";

function isImageType(fileType?: string) {
  return Boolean(fileType?.startsWith("image/"));
}

function getImageSrc(att: MessageAttachmentMeta): string | null {
  if (att.previewUrl) return att.previewUrl;
  if (att.id) return getAttachmentUrl(att.id);
  return null;
}

function getFileHref(att: MessageAttachmentMeta): string | null {
  if (att.id) return getAttachmentUrl(att.id);
  return null;
}

export function DesktopMessageAttachments({
  attachments,
  className,
}: {
  attachments: MessageAttachmentMeta[];
  className?: string;
}) {
  if (!attachments || attachments.length === 0) return null;

  const imageAttachments = attachments.filter((att) => isImageType(att.fileType));
  const fileAttachments = attachments.filter((att) => !isImageType(att.fileType));
  const isSingleImage = imageAttachments.length === 1 && fileAttachments.length === 0;
  const imagesForPreview = imageAttachments
    .map((att) => ({ att, src: getImageSrc(att) }))
    .filter((x): x is { att: MessageAttachmentMeta; src: string } => Boolean(x.src));

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const openAt = (idx: number) => {
    setActiveIndex(Math.max(0, Math.min(idx, Math.max(0, imagesForPreview.length - 1))));
    setLightboxOpen(true);
  };

  const canPrev = activeIndex > 0;
  const canNext = activeIndex < imagesForPreview.length - 1;

  return (
    <div className={cn("mb-2 flex flex-col gap-2", className)}>
      {imagesForPreview.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {imagesForPreview.map(({ att, src }, idx) => (
            <button
              key={att.id || `${att.fileName}-${idx}`}
              type="button"
              className={cn(
                "group/image relative shrink-0 overflow-hidden rounded-lg",
                isSingleImage ? "h-[200px] w-[280px]" : "size-[280px]",
              )}
              onClick={() => openAt(idx)}
              title={att.fileName}
              aria-label="Preview image"
            >
              <img
                src={src}
                alt={att.fileName}
                className={cn(
                  "size-full",
                  isSingleImage ? "bg-muted/10 object-contain" : "object-cover",
                )}
              />
            </button>
          ))}
        </div>
      )}

      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att, idx) => {
            const href = getFileHref(att);
            const label = truncateName(att.fileName);
            return href ? (
              <a
                key={att.id || `${att.fileName}-${idx}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10 px-3 py-1.5 text-[13px] text-[#37a5aa] transition-colors hover:bg-[#37a5aa]/15"
                title={att.fileName}
              >
                <Paperclip className="size-4" />
                <span>{label}</span>
              </a>
            ) : (
              <div
                key={att.id || `${att.fileName}-${idx}`}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10 px-3 py-1.5 text-[13px] text-[#37a5aa] opacity-70"
                title={att.fileName}
              >
                <Paperclip className="size-4" />
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-[min(980px,94vw)] overflow-hidden p-0">
          <DialogDescription className="sr-only">
            {getChatLabel("chat.attachment.lightboxDescription")}
          </DialogDescription>
          <div className="relative bg-background">
            <DialogClose className="absolute right-3 top-3 z-10 rounded-full bg-background/80 p-1.5 text-foreground/70 shadow-sm backdrop-blur hover:text-foreground">
              <X className="size-5" />
            </DialogClose>

            {imagesForPreview[activeIndex] && (
              <div className="flex items-center justify-center p-4">
                <img
                  src={imagesForPreview[activeIndex].src}
                  alt={imagesForPreview[activeIndex].att.fileName}
                  className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain"
                />
              </div>
            )}

            {imagesForPreview.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveIndex((idx) => Math.max(0, idx - 1))}
                  disabled={!canPrev}
                  className={cn(
                    "absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground/70 shadow-sm backdrop-blur",
                    "hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                  aria-label="Previous image"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setActiveIndex((idx) => Math.min(imagesForPreview.length - 1, idx + 1))
                  }
                  disabled={!canNext}
                  className={cn(
                    "absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground/70 shadow-sm backdrop-blur",
                    "hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                  aria-label="Next image"
                >
                  <ChevronRight className="size-5" />
                </button>
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
                  {activeIndex + 1} / {imagesForPreview.length}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
