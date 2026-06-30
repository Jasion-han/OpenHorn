import type { AttachmentPart } from "shared/types";

/**
 * Maximum number of characters injected per file attachment. Large files are
 * truncated so a single attachment cannot blow past the model context window.
 */
export const MAX_FILE_TEXT_CHARS = 12_000;

/**
 * Normalized image attachment ready for per-runtime vision injection.
 */
export type ImageAttachment = {
  mediaType: string;
  dataBase64: string;
  fileName?: string;
};

/**
 * Builds a plain-text context block from the *file* attachments only. File
 * attachments carry already-extracted UTF-8 text (text/code/JSON/PDF text) so
 * every runtime — regardless of vision support — can reference their contents.
 *
 * Image attachments are intentionally ignored here: vision-capable runtimes
 * inject them as real image content blocks, and non-vision runtimes append a
 * separate textual fallback via {@link imageFallbackText}.
 *
 * Returns an empty string when there are no file attachments so callers can
 * append unconditionally without introducing trailing whitespace.
 */
export function buildFileContext(attachments?: AttachmentPart[]): string {
  if (!attachments || attachments.length === 0) return "";

  const blocks: string[] = [];
  for (const part of attachments) {
    if (part.kind !== "file") continue;
    const text =
      part.text.length > MAX_FILE_TEXT_CHARS
        ? `${part.text.slice(0, MAX_FILE_TEXT_CHARS)}\n…[内容过长，已截断]`
        : part.text;
    blocks.push(`\n\n[附件文件] ${part.fileName}:\n${text}`);
  }
  return blocks.join("");
}

/**
 * Image media types every supported vision provider accepts. Anthropic's
 * `Base64ImageSource.media_type` is the strict enum below, and the OpenAI /
 * Google vision endpoints accept the same set, so we gate real image injection
 * on it. Anything outside this set degrades to a textual placeholder instead of
 * erroring the whole run with a 400.
 */
export const VISION_SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Normalizes a browser-provided image mime to the provider enum. Notably maps
 * the occasional `image/jpg` to the canonical `image/jpeg`; everything else is
 * lower-cased/trimmed so the support check is exact.
 */
export function normalizeImageMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase().trim();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

/** True when the (normalized) media type is accepted by vision providers. */
export function isVisionSupportedImageType(mediaType: string): boolean {
  return VISION_SUPPORTED_IMAGE_TYPES.has(normalizeImageMediaType(mediaType));
}

/**
 * Splits images into those that can be sent as real vision blocks (supported
 * format, media type normalized) and those whose format the providers reject.
 * Order is preserved within each bucket.
 */
export function partitionImagesByFormat(images: ImageAttachment[]): {
  injectable: ImageAttachment[];
  unsupported: ImageAttachment[];
} {
  const injectable: ImageAttachment[] = [];
  const unsupported: ImageAttachment[] = [];
  for (const img of images) {
    if (isVisionSupportedImageType(img.mediaType)) {
      injectable.push({ ...img, mediaType: normalizeImageMediaType(img.mediaType) });
    } else {
      unsupported.push(img);
    }
  }
  return { injectable, unsupported };
}

/**
 * Extracts the image attachments as runtime-agnostic payloads. The order of the
 * original attachment list is preserved.
 */
export function getImageAttachments(attachments?: AttachmentPart[]): ImageAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  const images: ImageAttachment[] = [];
  for (const part of attachments) {
    if (part.kind === "image") {
      images.push({
        mediaType: part.mediaType,
        dataBase64: part.dataBase64,
        fileName: part.fileName,
      });
    }
  }
  return images;
}

/**
 * Textual fallback for image attachments when the active model does not support
 * vision. The image bytes are dropped (sending them would error on a text-only
 * endpoint); instead the model is told an image was attached but ignored.
 *
 * Returns an empty string when there are no images so callers can append
 * unconditionally.
 */
export function imageFallbackText(images: ImageAttachment[]): string {
  if (images.length === 0) return "";
  const blocks: string[] = [];
  for (const img of images) {
    blocks.push(`\n\n[图片附件：${img.fileName || "image"}] 当前模型不支持视觉，已忽略图片内容。`);
  }
  return blocks.join("");
}

/**
 * Textual fallback for image attachments whose format the vision provider does
 * not accept (e.g. bmp/svg/heic). The model *is* vision-capable, but sending an
 * unsupported media type would error, so we drop the bytes and note the format.
 *
 * Returns an empty string when there are no such images.
 */
export function imageUnsupportedFormatText(images: ImageAttachment[]): string {
  if (images.length === 0) return "";
  const blocks: string[] = [];
  for (const img of images) {
    blocks.push(
      `\n\n[图片附件：${img.fileName || "image"}] 图片格式 ${img.mediaType} 不受支持，已忽略图片内容。`,
    );
  }
  return blocks.join("");
}

/**
 * Convenience helper that appends file context plus, when the model is not
 * vision-capable, the image fallback text. Vision-capable runtimes should call
 * {@link buildFileContext} / {@link getImageAttachments} directly so they can
 * inject real image content blocks.
 */
export function appendAttachmentContext(
  prompt: string,
  attachments?: AttachmentPart[],
  options?: { includeImageFallback?: boolean },
): string {
  let result = prompt;
  const fileContext = buildFileContext(attachments);
  if (fileContext) result += fileContext;
  if (options?.includeImageFallback !== false) {
    const fallback = imageFallbackText(getImageAttachments(attachments));
    if (fallback) result += fallback;
  }
  return result;
}
