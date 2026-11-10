import { useEffect, useRef, useState } from "react";
import type { LibraryQuestion } from "shared/types";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "ui";
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { libraryApi, libraryError } from "../../lib/libraryApi";
export function LibraryHistoryDialog({
  onClose,
  onOpen,
  owns,
  errorMessage,
}: {
  onClose(): void;
  onOpen(id: string): Promise<void>;
  owns(): boolean;
  errorMessage: string;
}) {
  const [items, setItems] = useState<LibraryQuestion[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<string | null>(null);
  const mounted = useRef(true),
    lock = useRef(false),
    readEpoch = useRef(0);
  const valid = () => mounted.current && owns();
  const load = async () => {
    const token = ++readEpoch.current;
    const current = () => valid() && token === readEpoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await libraryApi.questions();
      if (current()) setItems(result.questions);
    } catch (error) {
      if (current()) setError(libraryError(error));
    } finally {
      if (current()) setLoading(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: dialog lifetime owns the initial read
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      readEpoch.current++;
    };
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{label("library.history")}</DialogTitle>
          <DialogDescription>{label("library.questionHistoryHint")}</DialogDescription>
        </DialogHeader>
        {(error || errorMessage) && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{error || errorMessage}</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
              {label("library.retry")}
            </Button>
          </div>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">{label("library.loading")}</p>
        ) : !items.length ? (
          <p className="py-6 text-sm text-muted-foreground">{label("library.noQuestions")}</p>
        ) : (
          <ol className="divide-y">
            {items.map((item) => (
              <li key={item.id} className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{item.question}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()}
                      {!item.scopeAvailable && ` · ${label("library.unavailableScope")}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !item.conversationId || !item.scopeAvailable}
                    onClick={async () => {
                      if (lock.current) return;
                      lock.current = true;
                      setBusy(true);
                      try {
                        await onOpen(item.id);
                      } finally {
                        lock.current = false;
                        if (valid()) setBusy(false);
                      }
                    }}
                  >
                    {label("library.resumeDraft")}
                  </Button>
                </div>
                {(!item.conversationId || !item.scopeAvailable) && (
                  <p className="text-xs text-muted-foreground">
                    {label("library.missingConversation")}
                  </p>
                )}
                <details className="space-y-3">
                  <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    {label("library.sourceSnapshot")} · {item.sources.length}
                  </summary>
                  {item.sources.map((source, index) => (
                    <section
                      key={`${source.documentId}:${source.chunkIndex}`}
                      className="space-y-2 border-l-2 pl-3"
                    >
                      <h3 className="break-words text-xs font-medium">
                        {index + 1}. {source.fileName} ·{" "}
                        {format("library.chunk", { number: source.chunkIndex + 1 })}
                      </h3>
                      <pre className="whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">
                        {source.text}
                      </pre>
                    </section>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setDeleting(item.id)}
                  >
                    {label("library.deleteQuestion")}
                  </Button>
                </details>
                {deleting === item.id && (
                  <div role="alert" className="space-y-3 border-t pt-3">
                    <p className="text-xs text-muted-foreground">
                      {label("library.deleteQuestionHint")}
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        {label("library.cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={async () => {
                          if (lock.current) return;
                          lock.current = true;
                          setBusy(true);
                          try {
                            readEpoch.current++;
                            await libraryApi.deleteQuestion(item.id);
                            if (valid()) {
                              setItems((rows) => rows.filter((q) => q.id !== item.id));
                              setDeleting(null);
                            }
                          } catch (error) {
                            if (valid()) setError(libraryError(error));
                          } finally {
                            lock.current = false;
                            if (valid()) setBusy(false);
                          }
                        }}
                      >
                        {label("library.deleteQuestion")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
