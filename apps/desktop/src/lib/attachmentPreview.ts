import type { MessageAttachmentMeta } from "../types/chat";
import { getAttachmentUrl } from "./attachmentUrl";
import { isDesktopRuntime } from "./tauriBridge";

export type AttachmentKind = "image" | "text" | "markdown" | "pdf" | "audio" | "video" | "file";

export function attachmentKind(att: MessageAttachmentMeta): AttachmentKind {
  const type = att.fileType?.split(";")[0].toLowerCase() ?? "";
  const ext = att.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (
    type.startsWith("image/") ||
    /^(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif|tiff?)$/.test(ext)
  )
    return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("audio/") || /^(mp3|wav|ogg|m4a|flac|aac)$/.test(ext)) return "audio";
  if (type.startsWith("video/") || /^(mp4|webm|mov|m4v)$/.test(ext)) return "video";
  if (type === "text/markdown" || /^(md|markdown)$/.test(ext)) return "markdown";
  if (
    type.startsWith("text/") ||
    /(?:json|xml|javascript|yaml|x-sh)$/.test(type) ||
    /^(txt|log|jsonc?|csv|tsv|ya?ml|toml|ini|env|xml|html?|css|scss|less|[cm]?js|jsx|ts|tsx|py|rb|go|rs|java|kt|[ch]|cpp|hpp|cc|cs|php|swift|sh|bash|zsh|sql|vue|svelte|dart|lua|r)$/.test(
      ext,
    )
  )
    return "text";
  return "file";
}

export async function loadAttachmentBlob(
  att: MessageAttachmentMeta,
  file?: File,
  signal?: AbortSignal,
): Promise<Blob> {
  if (file) return file;
  const urls = [att.previewUrl, att.id ? getAttachmentUrl(att.id) : undefined].filter(
    (url): url is string => Boolean(url),
  );
  if (!urls.length) throw new Error("unavailable");
  for (let index = 0; index < urls.length; index++) {
    let response: Response;
    try {
      response = await fetch(urls[index], { credentials: "include", signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (index + 1 < urls.length) continue;
      throw new Error("network");
    }
    if (response.ok) return response.blob();
    if ([401, 403].includes(response.status)) throw new Error("auth");
    if (index + 1 < urls.length) continue;
    throw new Error(response.status === 404 ? "unavailable" : "network");
  }
  throw new Error("unavailable");
}

export function previewMediaType(att: MessageAttachmentMeta, originalType: string): string {
  if (attachmentKind(att) === "pdf") return "application/pdf";
  const type = originalType || att.fileType;
  if (type && type !== "application/octet-stream") return type;
  const extension = att.fileName.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    heic: "image/heic",
    heif: "image/heif",
    tif: "image/tiff",
    tiff: "image/tiff",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    flac: "audio/flac",
    aac: "audio/aac",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/mp4",
  };
  return types[extension] || type || "application/octet-stream";
}

export async function readPreviewText(blob: Blob, limit = 2 * 1024 * 1024) {
  const truncated = blob.size > limit;
  // Streaming decode omits a partial final codepoint at the preview boundary.
  const bytes = new Uint8Array(await blob.slice(0, limit).arrayBuffer());
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding).decode(bytes, { stream: truncated });
  return { text, truncated };
}

export function canOpenAttachment(fileName: string) {
  return /\.(txt|log|md|markdown|json|csv|tsv|pdf|png|jpe?g|gif|webp|bmp|heic|heif|tiff?|mp3|wav|ogg|m4a|flac|mp4|webm|mov|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(
    fileName,
  );
}

export async function saveAttachment(blob: Blob, fileName: string) {
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_attachment", {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      fileName,
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function openAttachmentInDefaultApp(blob: Blob, fileName: string) {
  if (!isDesktopRuntime()) throw new Error("Native file opening unavailable");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_attachment", {
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    fileName,
  });
}
