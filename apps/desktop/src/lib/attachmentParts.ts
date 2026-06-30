import type { AttachmentPart } from "shared/types";

/**
 * Converts the desktop composer's raw `File[]` into normalized
 * `AttachmentPart[]` for local (sidecar) agent runs:
 *
 *  - `image/*`            → base64 image part (vision injection lands in phase B)
 *  - text / code / json  → UTF-8 text part read client-side via `file.text()`
 *  - `application/pdf`    → text part with per-page text extracted via pdf.js
 *  - anything else        → text part flagged as unsupported
 *
 * All reading happens in the renderer; the sidecar never touches the original
 * files. Failures are isolated per file so one bad attachment never blocks the
 * rest of the run.
 */

const TEXT_LIKE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
  "log",
  "vue",
  "svelte",
  "dart",
  "lua",
  "r",
]);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isTextLike(file: File): boolean {
  const type = file.type || "";
  if (type.startsWith("text/")) return true;
  if (
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-yaml" ||
    type === "application/x-sh"
  ) {
    return true;
  }
  return TEXT_LIKE_EXTENSIONS.has(fileExtension(file.name));
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

let pdfWorkerConfigured = false;

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfWorkerConfigured) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    pdfWorkerConfigured = true;
  }
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (text) pages.push(`[第 ${pageNum} 页]\n${text}`);
  }
  await doc.destroy();
  return pages.join("\n\n");
}

async function fileToAttachmentPart(file: File): Promise<AttachmentPart> {
  const mediaType = file.type || "application/octet-stream";

  if (mediaType.startsWith("image/")) {
    return {
      kind: "image",
      mediaType,
      dataBase64: await fileToBase64(file),
      fileName: file.name,
    };
  }

  if (mediaType === "application/pdf" || fileExtension(file.name) === "pdf") {
    try {
      const text = await extractPdfText(file);
      return {
        kind: "file",
        fileName: file.name,
        mediaType: "application/pdf",
        text: text || "[PDF 未提取到文本内容]",
      };
    } catch {
      return {
        kind: "file",
        fileName: file.name,
        mediaType: "application/pdf",
        text: "[PDF 解析失败，未提取内容]",
      };
    }
  }

  if (isTextLike(file)) {
    const text = await file.text();
    return { kind: "file", fileName: file.name, mediaType, text };
  }

  return {
    kind: "file",
    fileName: file.name,
    mediaType,
    text: "[不支持的文件类型，未解析内容]",
  };
}

export async function filesToAttachmentParts(files: File[]): Promise<AttachmentPart[]> {
  const parts: AttachmentPart[] = [];
  for (const file of files) {
    try {
      parts.push(await fileToAttachmentPart(file));
    } catch {
      parts.push({
        kind: "file",
        fileName: file.name,
        mediaType: file.type || "application/octet-stream",
        text: "[读取文件失败，未解析内容]",
      });
    }
  }
  return parts;
}
