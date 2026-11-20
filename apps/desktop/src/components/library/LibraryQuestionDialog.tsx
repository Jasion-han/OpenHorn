import { useMemo, useRef, useState } from "react";
import { LIBRARY_LIMITS, libraryScopeKey } from "shared/library";
import type {
  LibraryQuestionSourceRef,
  LibraryScope,
  LibrarySourceLocation,
  PrepareLibraryQuestionInput,
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
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { useChatStore } from "../../stores/chatStore";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { DiscardChangesNotice } from "../workbench/DiscardChangesNotice";
import { reviewSelectClass } from "../workbench/reviews/ReviewImportDialog";
import { formatLibraryLocation } from "./LibrarySourceLocation";

export interface LibraryQuestionSelection {
  scope: LibraryScope;
  reference: LibraryQuestionSourceRef;
  fileName: string;
  location?: LibrarySourceLocation;
}

export function LibraryQuestionDialog({
  scope,
  scopeName,
  selectedSource,
  errorMessage,
  onClose,
  onReselect,
  onPrepare,
}: {
  scope: LibraryScope;
  scopeName: string;
  selectedSource?: LibraryQuestionSelection;
  errorMessage: string;
  onClose(): void;
  onReselect?(): void;
  onPrepare(input: PrepareLibraryQuestionInput): Promise<boolean>;
}) {
  const source = selectedSource?.reference;
  // Keep the wording when the same chunk is explicitly reselected after a refresh.
  // The submission signature still includes the revision.
  const draftKey = source
    ? JSON.stringify([libraryScopeKey(scope), source.documentId, source.chunkIndex])
    : libraryScopeKey(scope);
  const draftStore = useLibraryDraftStore.getState();
  const cached = source ? draftStore.sourceQuestion : draftStore.question;
  const draft = cached?.scope === draftKey ? cached : null;
  const writeDraft = (value: Parameters<typeof draftStore.setQuestion>[0]) =>
    draftStore.setQuestion(value, !!source);
  const channels = useChatStore((s) => s.channels);
  const models = useMemo(
    () =>
      channels
        .filter((c) => c.enabled && c.hasApiKey && c.protocol !== "acp")
        .flatMap((c) =>
          c.models
            .filter((m) => m.enabled)
            .map((m) => ({
              value: JSON.stringify([c.id, m.modelId]),
              label: `${c.name} / ${m.displayName || m.modelId}`,
            })),
        ),
    [channels],
  );
  const [question, setQuestion] = useState(draft?.text ?? ""),
    [model, setModel] = useState(() => {
      if (draft?.model) return draft.model;
      const fallback = getGlobalDefaultChannel(channels);
      return fallback
        ? JSON.stringify([fallback.channelId, fallback.modelId])
        : (models[0]?.value ?? "");
    });
  const [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  const retry = useRef<{ signature: string; requestId: string } | null>(
      draft?.requestId ? { signature: draft.signature, requestId: draft.requestId } : null,
    ),
    lock = useRef(false);
  const validModel = models.some((m) => m.value === model);
  const close = () => {
    if (lock.current) return;
    if (question.trim()) setDiscard(true);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{label("library.askTitle")}</DialogTitle>
          <DialogDescription>{scopeName}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current || discard || onReselect || !question.trim() || !validModel) return;
            const signature = JSON.stringify(
              source ? [scope, question.trim(), model, source] : [scope, question.trim(), model],
            );
            const requestId =
              retry.current?.signature === signature
                ? retry.current.requestId
                : crypto.randomUUID();
            retry.current = { signature, requestId };
            writeDraft({
              scope: draftKey,
              text: question,
              model,
              requestId,
              signature,
            });
            lock.current = true;
            setBusy(true);
            try {
              const [channelId, modelId] = JSON.parse(model) as [string, string];
              if (
                await onPrepare({
                  scope,
                  question: question.trim(),
                  requestId,
                  channelId,
                  modelId,
                  ...(source ? { source } : {}),
                })
              )
                onClose();
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          {selectedSource && (
            <div className="space-y-1 rounded-md border border-border bg-muted/50 px-3 py-2">
              <p className="break-words text-sm font-medium">{selectedSource.fileName}</p>
              <p className="text-xs text-muted-foreground">
                {[
                  formatLibraryLocation(selectedSource.location),
                  format("library.chunk", { number: selectedSource.reference.chunkIndex + 1 }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="library-question">{label("library.question")}</Label>
            <Textarea
              autoFocus
              id="library-question"
              rows={4}
              maxLength={LIBRARY_LIMITS.questionChars}
              placeholder={label("library.questionPlaceholder")}
              value={question}
              disabled={busy || discard}
              onChange={(event) => {
                setQuestion(event.target.value);
                writeDraft({
                  scope: draftKey,
                  text: event.target.value,
                  model,
                  requestId: "",
                  signature: "",
                });
              }}
            />
          </div>
          <details className="space-y-2" open={!validModel}>
            <summary className="w-fit cursor-pointer rounded text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {label("library.modelOptions")}
              {validModel && ` · ${models.find((m) => m.value === model)?.label}`}
            </summary>
            <div className="space-y-2 pt-2">
              <Label htmlFor="library-model">{label("library.model")}</Label>
              <select
                id="library-model"
                className={`${reviewSelectClass} w-full`}
                value={validModel ? model : ""}
                disabled={busy || discard}
                onChange={(event) => {
                  setModel(event.target.value);
                  writeDraft({
                    scope: draftKey,
                    text: question,
                    model: event.target.value,
                    requestId: "",
                    signature: "",
                  });
                }}
              >
                <option value="">{label("library.chooseModel")}</option>
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              {!validModel && (
                <p className="text-xs text-muted-foreground">{label("library.errors.channel")}</p>
              )}
            </div>
          </details>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DiscardChangesNotice
            open={discard}
            onKeep={() => setDiscard(false)}
            onDiscard={() => {
              writeDraft(null);
              onClose();
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy || discard} onClick={close}>
              {label("library.cancel")}
            </Button>
            {onReselect ? (
              <Button type="button" disabled={busy || discard} onClick={onReselect}>
                {label("library.reselectSource")}
              </Button>
            ) : (
              <Button type="submit" disabled={busy || discard || !question.trim() || !validModel}>
                {label(busy ? "library.working" : "library.prepare")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
