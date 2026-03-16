'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAttachmentUrl } from '@/lib/attachment-url';
import { Dialog, DialogContent, DialogClose } from '@/components/ui/dialog';

export type MessageAttachmentItem = {
  id?: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
  previewUrl?: string;
};

function isImageType(fileType?: string) {
  return Boolean(fileType && fileType.startsWith('image/'));
}

function truncateName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

function getImageSrc(att: MessageAttachmentItem): string | null {
  if (att.previewUrl) return att.previewUrl;
  if (att.id) return getAttachmentUrl(att.id);
  return null;
}

function getFileHref(att: MessageAttachmentItem): string | null {
  if (att.id) return getAttachmentUrl(att.id);
  return null;
}

export function MessageAttachments({
  attachments,
  className,
}: {
  attachments: MessageAttachmentItem[];
  className?: string;
}): React.ReactElement | null {
  const imageAttachments = (attachments || []).filter((att) => isImageType(att.fileType));
  const fileAttachments = (attachments || []).filter((att) => !isImageType(att.fileType));
  const isSingleImage = imageAttachments.length === 1 && fileAttachments.length === 0;

  const imagesForPreview = imageAttachments
    .map((att) => ({ att, src: getImageSrc(att) }))
    .filter((x): x is { att: MessageAttachmentItem; src: string } => Boolean(x.src));

  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);

  const openAt = (idx: number) => {
    setActiveIndex(Math.max(0, Math.min(idx, Math.max(0, imagesForPreview.length - 1))));
    setLightboxOpen(true);
  };

  const canPrev = activeIndex > 0;
  const canNext = activeIndex < imagesForPreview.length - 1;

  const onPrev = () => setActiveIndex((i) => Math.max(0, i - 1));
  const onNext = () => setActiveIndex((i) => Math.min(imagesForPreview.length - 1, i + 1));

  if (!attachments || attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-2 mb-2', className)}>
      {imagesForPreview.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {imagesForPreview.map(({ att, src }, idx) => (
            <button
              key={att.id || `${att.fileName}-${idx}`}
              type="button"
              className={cn(
                'group/image relative shrink-0 rounded-lg overflow-hidden',
                isSingleImage ? 'w-[280px] h-[200px]' : 'size-[280px]'
              )}
              onClick={() => openAt(idx)}
              title={att.fileName}
              aria-label="Preview image"
            >
              <img
                src={src}
                alt={att.fileName}
                className={cn(
                  'size-full',
                  isSingleImage ? 'object-contain bg-muted/10' : 'object-cover'
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
                className="flex items-center gap-2 rounded-lg bg-[#37a5aa]/10 border border-[#37a5aa]/20 px-3 py-1.5 text-[13px] text-[#37a5aa] shrink-0 hover:bg-[#37a5aa]/15 transition-colors"
                title={att.fileName}
              >
                <Paperclip className="size-4" />
                <span>{label}</span>
              </a>
            ) : (
              <div
                key={att.id || `${att.fileName}-${idx}`}
                className="flex items-center gap-2 rounded-lg bg-[#37a5aa]/10 border border-[#37a5aa]/20 px-3 py-1.5 text-[13px] text-[#37a5aa] shrink-0 opacity-70"
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
        <DialogContent className="max-w-[min(980px,94vw)] p-0 overflow-hidden">
          <div className="relative bg-background">
            <DialogClose className="absolute right-3 top-3 z-10 rounded-full bg-background/80 p-1.5 text-foreground/70 shadow-sm backdrop-blur hover:text-foreground">
              <X className="size-5" />
            </DialogClose>

            {imagesForPreview[activeIndex] && (
              <div className="flex items-center justify-center p-4">
                <img
                  src={imagesForPreview[activeIndex].src}
                  alt={imagesForPreview[activeIndex].att.fileName}
                  className="max-h-[80vh] w-auto max-w-full object-contain rounded-lg"
                />
              </div>
            )}

            {imagesForPreview.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={onPrev}
                  disabled={!canPrev}
                  className={cn(
                    'absolute left-3 top-1/2 -translate-y-1/2 z-10',
                    'rounded-full bg-background/80 p-2 text-foreground/70 shadow-sm backdrop-blur',
                    'hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed'
                  )}
                  aria-label="Previous image"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  onClick={onNext}
                  disabled={!canNext}
                  className={cn(
                    'absolute right-3 top-1/2 -translate-y-1/2 z-10',
                    'rounded-full bg-background/80 p-2 text-foreground/70 shadow-sm backdrop-blur',
                    'hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed'
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

