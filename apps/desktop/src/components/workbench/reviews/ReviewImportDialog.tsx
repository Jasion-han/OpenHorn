import { useEffect, useMemo, useRef, useState } from "react";
import {
  createReviewData,
  parseReviewCsv,
  REVIEW_LIMITS,
  ReviewValidationError,
} from "shared/reviews";
import type { CreateReviewWorkspaceInput, ReviewDelimiter } from "shared/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "ui";
import {
  formatWorkbenchLabel as format,
  getWorkbenchLabel as label,
} from "../../../lib/i18n/agent";
import { reviewError } from "../../../lib/reviewWorkspaceApi";
import { DiscardChangesNotice } from "../DiscardChangesNotice";

export const reviewSelectClass =
  "h-9 max-w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function ReviewImportDialog({
  onClose,
  onSave,
}: {
  onClose(): void;
  onSave(input: CreateReviewWorkspaceInput): Promise<void>;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [title, setTitle] = useState("");
  const [delimiter, setDelimiter] = useState<ReviewDelimiter>(",");
  const [textColumn, setTextColumn] = useState(0);
  const [ratingColumn, setRatingColumn] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const source = useMemo(
    () => ({ csv: csv ?? "", fileName, delimiter, textColumn, ratingColumn }),
    [csv, fileName, delimiter, textColumn, ratingColumn],
  );
  const preview = useMemo(() => {
    if (csv === null) return null;
    try {
      return {
        data: createReviewData(source),
        headers: parseReviewCsv(csv, delimiter).headers,
        error: "",
      };
    } catch (error) {
      let headers: string[] = [];
      try {
        headers = parseReviewCsv(csv, delimiter).headers;
      } catch {
        /* invalid CSV remains editable */
      }
      return { data: null, headers, error: reviewError(error) };
    }
  }, [csv, delimiter, source]);
  const close = () => {
    if (busy || reading) return;
    if (csv !== null || title) setDiscard(true);
    else onClose();
  };
  const read = async (file?: File) => {
    const token = ++epoch.current;
    setCsv(null);
    setError("");
    setReading(!!file);
    if (!file) return;
    try {
      if (file.size > REVIEW_LIMITS.csvBytes) throw new ReviewValidationError("review_limit");
      const buffer = await file.arrayBuffer();
      if (token !== epoch.current) return;
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        setError(label("reviews.errors.encoding"));
        return;
      }
      setCsv(content);
      setFileName(file.name.slice(0, 200));
      setTitle(file.name.replace(/\.(csv|tsv)$/i, "").slice(0, 200));
      setTextColumn(0);
      setRatingColumn(null);
      setDelimiter(file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",");
    } catch (error) {
      if (token === epoch.current) setError(reviewError(error));
    } finally {
      if (token === epoch.current) setReading(false);
    }
  };
  const save = async () => {
    if (lock.current || !preview?.data || !title.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave({ ...source, title: title.trim() });
      onClose();
    } catch (error) {
      setError(reviewError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (discard) {
            event.preventDefault();
            setDiscard(false);
          }
        }}
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{label("reviews.import")}</DialogTitle>
          <DialogDescription>{label("reviews.limits")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="review-file">{label("reviews.file")}</Label>
            <Input
              id="review-file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              disabled={busy}
              onChange={(event) => void read(event.target.files?.[0])}
            />
          </div>
          {reading && (
            <output className="block text-sm text-muted-foreground">
              {label("reviews.reading")}
            </output>
          )}
          {csv !== null && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="review-name">{label("reviews.name")}</Label>
                <Input
                  id="review-name"
                  value={title}
                  maxLength={200}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-delimiter">{label("reviews.delimiter")}</Label>
                  <select
                    id="review-delimiter"
                    className={reviewSelectClass}
                    disabled={busy}
                    value={delimiter}
                    onChange={(e) => {
                      setDelimiter(e.target.value as ReviewDelimiter);
                      setTextColumn(0);
                      setRatingColumn(null);
                    }}
                  >
                    <option value=",">{label("reviews.comma")}</option>
                    <option value=";">{label("reviews.semicolon")}</option>
                    <option value={"\t"}>{label("reviews.tab")}</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-text-column">{label("reviews.textColumn")}</Label>
                  <select
                    id="review-text-column"
                    className={reviewSelectClass}
                    disabled={busy}
                    value={textColumn}
                    onChange={(e) => setTextColumn(Number(e.target.value))}
                  >
                    {preview?.headers.map((name, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: CSV column position is its stable identity, including duplicate/empty headers
                      <option key={`${i}-${name}`} value={i}>
                        {format("reviews.column", {
                          index: i + 1,
                          name: name || label("reviews.unnamed"),
                        })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="review-rating-column">{label("reviews.ratingColumn")}</Label>
                  <select
                    id="review-rating-column"
                    className={reviewSelectClass}
                    disabled={busy}
                    value={ratingColumn ?? ""}
                    onChange={(e) =>
                      setRatingColumn(e.target.value === "" ? null : Number(e.target.value))
                    }
                  >
                    <option value="">{label("reviews.none")}</option>
                    {preview?.headers.map((name, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: CSV column position is its stable identity, including duplicate/empty headers
                      <option key={`${i}-${name}`} value={i}>
                        {format("reviews.column", {
                          index: i + 1,
                          name: name || label("reviews.unnamed"),
                        })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {preview?.data && (
                <section className="space-y-2" aria-label={label("reviews.preview")}>
                  <h3 className="text-sm font-medium">{label("reviews.preview")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {format("reviews.previewCount", {
                      count: preview.data.rows.length,
                      skipped: preview.data.skippedRows,
                    })}
                  </p>
                  <div className="divide-y rounded-md border">
                    {preview.data.rows.slice(0, 5).map((row) => (
                      <p key={row.id} className="whitespace-pre-wrap break-words px-3 py-2 text-sm">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {row.id}
                        </span>
                        {row.text}
                      </p>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {(error || preview?.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || preview?.error}
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {label("reviews.storage")}
          </p>
        </div>
        {discard ? (
          <DiscardChangesNotice
            open={discard}
            onKeep={() => setDiscard(false)}
            onDiscard={onClose}
          />
        ) : (
          <DialogFooter>
            <Button variant="outline" disabled={busy || reading} onClick={close}>
              {label("reviews.cancel")}
            </Button>
            <Button
              disabled={busy || reading || !preview?.data || !title.trim()}
              onClick={() => void save()}
            >
              {label(busy ? "reviews.working" : "reviews.create")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
