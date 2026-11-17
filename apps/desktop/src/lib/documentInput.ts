export const DOCUMENT_LIMITS = {
  pages: 6,
  imageBytes: 1024 * 1024,
  totalBytes: 6 * 1024 * 1024,
  edge: 1600,
} as const;
export type DocumentInputOption = { layout: boolean; pages: string };
export type DocumentInputCode =
  | "document_pages"
  | "document_size"
  | "document_render"
  | "document_vision"
  | "document_cache"
  | "document_upload"
  | "document_missing";
export class DocumentInputError extends Error {
  constructor(readonly code: DocumentInputCode) {
    super(code);
  }
}
export const isPdfDocument = (file: Pick<File, "type" | "name">) =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);

export function hasMissingPdfInput(message: {
  attachments?: string[];
  attachmentsMeta?: Array<{ fileName: string; fileType?: string }>;
}): boolean {
  return (
    !message.attachments?.some((id) => !id.startsWith("local:")) &&
    !!message.attachmentsMeta?.some((file) =>
      isPdfDocument({ name: file.fileName, type: file.fileType ?? "" }),
    )
  );
}

/** Match previews by File identity before attaching server IDs by upload order. */
export function alignDocumentMetadata<T>(
  expanded: File[],
  original: File[],
  metadata: T[],
  create: (file: File) => T,
): T[] {
  if (metadata.length !== original.length) throw new DocumentInputError("document_render");
  const source = new Map(original.map((file, index) => [file, metadata[index]]));
  return expanded.map((file) => (source.has(file) ? (source.get(file) as T) : create(file)));
}

/** Empty means all pages; exceeding the cap always requires an explicit choice. */
export function documentPageNumbers(value: string, count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new DocumentInputError("document_pages");
  if (!value.trim()) {
    if (count > DOCUMENT_LIMITS.pages) throw new DocumentInputError("document_pages");
    return Array.from({ length: count }, (_, index) => index + 1);
  }
  const selected = new Set<number>();
  for (const part of value.split(/[,，]/)) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new DocumentInputError("document_pages");
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > count ||
      end - start >= DOCUMENT_LIMITS.pages
    )
      throw new DocumentInputError("document_pages");
    for (let page = start; page <= end; page++) selected.add(page);
    if (selected.size > DOCUMENT_LIMITS.pages) throw new DocumentInputError("document_pages");
  }
  return [...selected].sort((a, b) => a - b);
}

export interface DocumentRenderer {
  pages: number;
  render(page: number, signal: AbortSignal): Promise<Blob>;
  destroy(): Promise<void>;
}

async function openPdf(file: File, signal: AbortSignal): Promise<DocumentRenderer> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  signal.throwIfAborted();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false });
  const abortLoading = () => {
    void task.destroy();
  };
  signal.addEventListener("abort", abortLoading, { once: true });
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    return {
      pages: pdf.numPages,
      async render(number, renderSignal) {
        renderSignal.throwIfAborted();
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, DOCUMENT_LIMITS.edge / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) throw new DocumentInputError("document_render");
        const rendering = page.render({ canvasContext: context, viewport });
        const cancel = () => rendering.cancel();
        renderSignal.addEventListener("abort", cancel, { once: true });
        try {
          await rendering.promise;
          renderSignal.throwIfAborted();
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.85),
          );
          renderSignal.throwIfAborted();
          if (!blob || blob.type !== "image/jpeg") throw new DocumentInputError("document_render");
          return blob;
        } finally {
          renderSignal.removeEventListener("abort", cancel);
          page.cleanup();
          canvas.width = 0;
          canvas.height = 0;
        }
      },
      async destroy() {
        signal.removeEventListener("abort", abortLoading);
        await task.destroy();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abortLoading);
    await task.destroy();
    throw error;
  }
}

/** Produce actual image files used by both upload/Chat and local/Agent pathways. */
export async function expandDocumentFiles(
  files: File[],
  optionFor: (file: File) => DocumentInputOption | undefined,
  supportsVision: boolean,
  signal: AbortSignal,
  renderer: (file: File, signal: AbortSignal) => Promise<DocumentRenderer> = openPdf,
): Promise<File[]> {
  const expanded: File[] = [];
  let pages = 0,
    bytes = 0;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    for (const file of files) {
      bounded.throwIfAborted();
      expanded.push(file);
      if (!isPdfDocument(file) || !optionFor(file)?.layout) continue;
      if (!supportsVision) throw new DocumentInputError("document_vision");
      if (file.size > 20 * 1024 * 1024) throw new DocumentInputError("document_size");
      const pdf = await renderer(file, bounded);
      try {
        const selection = documentPageNumbers(optionFor(file)?.pages ?? "", pdf.pages);
        if (pages + selection.length > DOCUMENT_LIMITS.pages)
          throw new DocumentInputError("document_pages");
        for (const number of selection) {
          bounded.throwIfAborted();
          const image = await pdf.render(number, bounded);
          bounded.throwIfAborted();
          bytes += image.size;
          pages++;
          if (
            !image.size ||
            image.size > DOCUMENT_LIMITS.imageBytes ||
            bytes > DOCUMENT_LIMITS.totalBytes
          )
            throw new DocumentInputError("document_size");
          expanded.push(
            new File([image], `${file.name} [page ${number}].jpg`, { type: "image/jpeg" }),
          );
        }
      } finally {
        await pdf.destroy();
      }
    }
    bounded.throwIfAborted();
    return expanded;
  } catch (error) {
    if (signal.aborted) throw error;
    throw error instanceof DocumentInputError ? error : new DocumentInputError("document_render");
  }
}
