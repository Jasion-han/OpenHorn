import { useRef, useState } from "react";
import { REVIEW_NOTE_POLICY } from "shared/review-note";
import { REVIEW_SENTIMENTS, ReviewValidationError, validateReviewResult } from "shared/reviews";
import type {
  ReviewAnnotation,
  ReviewNoteRequest,
  ReviewNoteVerificationResult,
  ReviewRecord,
} from "shared/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from "ui";
import {
  formatWorkbenchLabel as format,
  getWorkbenchLabel as label,
  presentJevTopic,
} from "../../../lib/i18n/agent";
import { ReviewApiError, reviewError } from "../../../lib/reviewWorkspaceApi";
import { DiscardChangesDialog } from "../DiscardChangesDialog";
import { reviewSelectClass } from "./ReviewImportDialog";

export function ReviewAnnotationDialog({
  row,
  revision,
  onClose,
  onSave,
  onVerify,
}: {
  row: ReviewRecord;
  revision: number;
  onClose(): void;
  onSave(revision: number, annotation: Omit<ReviewAnnotation, "source" | "runId">): Promise<void>;
  onVerify(revision: number, requestId: string): Promise<ReviewNoteVerificationResult>;
}) {
  const [baseline] = useState(() => ({
    sentiment: row.annotation?.sentiment ?? "unknown",
    topics: row.annotation?.topics.map(presentJevTopic).join("\n") ?? "",
    quote: row.annotation?.quote ?? "",
    note: row.annotation?.note ?? "",
    revision,
  }));
  const [sentiment, setSentiment] = useState(baseline.sentiment);
  const [topics, setTopics] = useState(baseline.topics);
  const [quote, setQuote] = useState(baseline.quote);
  const [note, setNote] = useState(baseline.note);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [check, setCheck] = useState(row.noteVerification ?? null);
  const [checkRequest, setCheckRequest] = useState<ReviewNoteRequest | null>(null);
  const [checkCached, setCheckCached] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saveRevision, setSaveRevision] = useState(baseline.revision);
  const checkRequestId = useRef(crypto.randomUUID());
  const locked = useRef(false);
  const changed =
    sentiment !== baseline.sentiment ||
    topics !== baseline.topics ||
    quote !== baseline.quote ||
    note !== baseline.note;
  const close = () => {
    if (busy) return;
    if (changed) setDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const { id: _id, ...annotation } = validateReviewResult(
        {
          id: row.id,
          sentiment,
          topics: topics
            .split("\n")
            .map((value, index) => {
              const trimmed = value.trim();
              const original = row.annotation?.topics[index];
              return original && presentJevTopic(original) === trimmed ? original : trimmed;
            })
            .filter(Boolean),
          quote,
          note,
        },
        row.text,
      );
      await onSave(saveRevision, annotation);
      onClose();
    } catch (error) {
      setError(
        error instanceof ReviewValidationError
          ? label("reviews.errors.annotation")
          : reviewError(error),
      );
      setConflict(error instanceof ReviewApiError && error.code === "review_conflict");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const verify = async () => {
    if (locked.current || changed || !baseline.note.trim()) return;
    locked.current = true;
    setBusy(true);
    setChecking(true);
    setError("");
    setConflict(false);
    try {
      const result = await onVerify(saveRevision, checkRequestId.current);
      setCheck(result.verification);
      setCheckRequest(result.request);
      setCheckCached(result.cached);
      // Only this accepted check ACK can advance the form's baseline; unrelated refreshes cannot.
      setSaveRevision(result.workspace.revision);
    } catch (error) {
      setError(reviewError(error));
      setConflict(error instanceof ReviewApiError && error.code === "review_conflict");
    } finally {
      locked.current = false;
      setBusy(false);
      setChecking(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {label("reviews.editTitle")} · {row.id}
            </DialogTitle>
            <DialogDescription>{label("reviews.editHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">{label("reviews.text")}</h3>
              <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-sm leading-relaxed">
                {row.text}
              </p>
            </section>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="review-sentiment">{label("reviews.sentiment")}</Label>
              <select
                id="review-sentiment"
                disabled={busy}
                className={reviewSelectClass}
                value={sentiment}
                onChange={(e) => setSentiment(e.target.value as typeof sentiment)}
              >
                {REVIEW_SENTIMENTS.map((value) => (
                  <option key={value} value={value}>
                    {label(`reviews.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="review-topics">{label("reviews.topics")}</Label>
              <Textarea
                id="review-topics"
                rows={3}
                disabled={busy}
                value={topics}
                onChange={(e) => setTopics(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{label("reviews.topicHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="review-quote">{label("reviews.quote")}</Label>
              <Textarea
                id="review-quote"
                rows={2}
                maxLength={160}
                disabled={busy}
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{label("reviews.quoteHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="review-note">{label("reviews.note")}</Label>
              <Textarea
                id="review-note"
                rows={3}
                maxLength={400}
                disabled={busy}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {label("reviews.source")}:{" "}
              {label(
                row.annotation?.source === "ai"
                  ? "reviews.ai"
                  : row.annotation?.source === "manual"
                    ? "reviews.manual"
                    : "reviews.unannotated",
              )}
              {row.annotation?.runId && (
                <span className="ml-2 break-all font-mono">{row.annotation.runId}</span>
              )}
            </p>
            <section className="space-y-2 rounded-md border bg-muted/20 p-3">
              <h3 className="text-sm font-medium">{label("reviews.check.title")}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {label("reviews.check.scope")}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || changed || !baseline.note.trim()}
                onClick={() => void verify()}
              >
                {label(checking ? "reviews.check.pending" : "reviews.check.action")}
              </Button>
              {changed && (
                <p className="text-xs text-muted-foreground">{label("reviews.check.saveFirst")}</p>
              )}
              {check && !changed && (
                <div className="space-y-1 text-sm" aria-live="polite">
                  <p className="font-medium">{label(`reviews.check.${check.verdict}`)}</p>
                  {(check.hasClaimsProbability === undefined ||
                    check.hasClaimsProbability >= REVIEW_NOTE_POLICY.supported) &&
                    check.verdict !== "not_applicable" && (
                      <p>
                        {format("reviews.check.probability", {
                          probability: Math.round(check.probability * 100),
                        })}
                      </p>
                    )}
                  {check.hasClaimsProbability !== undefined &&
                    check.hasClaimsProbability < REVIEW_NOTE_POLICY.supported && (
                      <p className="text-xs text-muted-foreground">
                        {label(
                          check.verdict === "not_applicable"
                            ? "reviews.check.noClaimsHint"
                            : "reviews.check.unclearClaimsHint",
                        )}
                      </p>
                    )}
                  {check.questionVersion !== REVIEW_NOTE_POLICY.questionVersion && (
                    <p className="text-xs text-muted-foreground">{label("reviews.check.legacy")}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {check.model} · {new Date(check.checkedAt).toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">{label("reviews.check.limit")}</p>
                  {checkCached && (
                    <p className="text-xs text-muted-foreground">{label("reviews.check.cached")}</p>
                  )}
                </div>
              )}
              {checkRequest && !changed && (
                <details className="text-xs">
                  <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {label("reviews.check.request")}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                    {JSON.stringify(checkRequest, null, 2)}
                  </pre>
                </details>
              )}
            </section>
            {error && (
              <div role="alert" className="space-y-1 text-sm text-destructive">
                <p>{error}</p>
                {conflict && <p className="text-xs">{label("reviews.conflictHint")}</p>}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              {label("reviews.close")}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {label(busy ? "reviews.working" : "reviews.saveAnnotation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog open={discard} onKeep={() => setDiscard(false)} onDiscard={onClose} />
    </>
  );
}
