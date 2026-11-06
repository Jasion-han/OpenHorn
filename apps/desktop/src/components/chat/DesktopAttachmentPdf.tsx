import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { getChatLabel } from "../../lib/i18n/agent";

export function DesktopAttachmentPdf({ blob, onError }: { blob: Blob; onError: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [foundPages, setFoundPages] = useState<number[]>([]);
  const [finding, setFinding] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof import("pdfjs-dist")["getDocument"]> | undefined;
    void (async () => {
      const pdf = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdf.GlobalWorkerOptions.workerSrc = worker.default;
      const data = await blob.arrayBuffer();
      if (cancelled) return;
      task = pdf.getDocument({ data, isEvalSupported: false });
      const document = await task.promise;
      if (!cancelled) setDoc(document);
    })().catch(() => {
      if (!cancelled) onError();
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [blob, onError]);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void (async () => {
      if (!doc || !canvas.current) return;
      const pdfPage = await doc.getPage(page);
      if (cancelled || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom });
      const element = canvas.current;
      element.width = viewport.width;
      element.height = viewport.height;
      const context = element.getContext("2d");
      if (!context) throw new Error("canvas");
      task = pdfPage.render({ canvasContext: context, viewport });
      await task.promise;
    })().catch(() => {
      if (!cancelled) onError();
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, onError]);
  useEffect(() => {
    let cancelled = false;
    setFoundPages([]);
    if (!doc || !query.trim()) {
      setFinding(false);
      return;
    }
    setFinding(true);
    const timer = setTimeout(() => {
      void (async () => {
        const found: number[] = [];
        for (let number = 1; number <= doc.numPages; number++) {
          if (cancelled) return;
          const pdfPage = await doc.getPage(number);
          const content = await pdfPage.getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          if (text.toLowerCase().includes(query.trim().toLowerCase())) found.push(number);
        }
        if (!cancelled) {
          setFoundPages(found);
          setFinding(false);
          if (found[0]) setPage(found[0]);
        }
      })().catch(() => {
        if (!cancelled) {
          setFinding(false);
          onError();
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, query, onError]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-center gap-3 border-b px-4 py-2 text-sm">
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
          disabled={!doc || page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          {getChatLabel("chat.attachment.previous")}
        </button>
        <span>
          {page} / {doc?.numPages ?? "…"}
        </span>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
          disabled={!doc || page >= doc.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          {getChatLabel("chat.attachment.next")}
        </button>
        <label>
          {getChatLabel("chat.attachment.zoom")}{" "}
          <select
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="rounded border bg-background p-1"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value * 100}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={getChatLabel("chat.attachment.search")}
          placeholder={getChatLabel("chat.attachment.search")}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {query && (
          <button
            type="button"
            disabled={finding || !foundPages.length}
            onClick={() => setPage(foundPages.find((p) => p > page) ?? foundPages[0])}
            className="rounded-md px-2 py-1 text-sm hover:bg-muted disabled:opacity-40"
          >
            {finding
              ? getChatLabel("chat.attachment.searching")
              : `${getChatLabel("chat.attachment.matchPages")}: ${foundPages.length}`}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
        {!doc && <output>{getChatLabel("chat.attachment.loading")}</output>}
        <canvas
          ref={canvas}
          className="mx-auto bg-white"
          aria-label={getChatLabel("chat.attachment.pdfPage")}
        />
      </div>
    </div>
  );
}
