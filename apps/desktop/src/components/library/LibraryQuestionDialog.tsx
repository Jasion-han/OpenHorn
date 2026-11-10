import { useMemo, useRef, useState } from "react";
import { LIBRARY_LIMITS, libraryScopeKey } from "shared/library";
import type { LibraryScope, PrepareLibraryQuestionInput } from "shared/types";
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
import { getLibraryLabel as label } from "../../lib/i18n/agent";
import { useChatStore } from "../../stores/chatStore";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { DiscardChangesNotice } from "../workbench/DiscardChangesNotice";
import { reviewSelectClass } from "../workbench/reviews/ReviewImportDialog";
export function LibraryQuestionDialog({
  scope,
  scopeName,
  errorMessage,
  onClose,
  onPrepare,
}: {
  scope: LibraryScope;
  scopeName: string;
  errorMessage: string;
  onClose(): void;
  onPrepare(input: PrepareLibraryQuestionInput): Promise<boolean>;
}) {
  const cached = useLibraryDraftStore.getState().question;
  const draft = cached?.scope === libraryScopeKey(scope) ? cached : null;
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
          <DialogDescription>{label("library.askHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (lock.current || !question.trim() || !validModel) return;
            const signature = JSON.stringify([scope, question.trim(), model]);
            const requestId =
              retry.current?.signature === signature
                ? retry.current.requestId
                : crypto.randomUUID();
            retry.current = { signature, requestId };
            useLibraryDraftStore.getState().setQuestion({
              scope: libraryScopeKey(scope),
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
                await onPrepare({ scope, question: question.trim(), requestId, channelId, modelId })
              ) {
                useLibraryDraftStore.getState().setQuestion(null);
                onClose();
              }
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-muted-foreground">
            {label("library.scope")} · {scopeName}
          </p>
          <div className="space-y-2">
            <Label htmlFor="library-question">{label("library.question")}</Label>
            <Textarea
              autoFocus
              id="library-question"
              rows={4}
              maxLength={LIBRARY_LIMITS.questionChars}
              placeholder={label("library.questionPlaceholder")}
              value={question}
              disabled={busy}
              onChange={(event) => {
                setQuestion(event.target.value);
                useLibraryDraftStore.getState().setQuestion({
                  scope: libraryScopeKey(scope),
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
                disabled={busy}
                onChange={(event) => {
                  setModel(event.target.value);
                  useLibraryDraftStore.getState().setQuestion({
                    scope: libraryScopeKey(scope),
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
              useLibraryDraftStore.getState().setQuestion(null);
              onClose();
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {label("library.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !question.trim() || !validModel}>
              {label(busy ? "library.working" : "library.prepare")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
