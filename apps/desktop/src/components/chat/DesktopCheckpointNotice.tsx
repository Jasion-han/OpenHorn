import { useId, useState } from "react";
import { Button } from "ui";
import { getChatLabel } from "../../lib/i18n/agent";

export function DesktopCheckpointNotice({
  conversationId,
  checkpointConversationId,
  runId,
  busy,
  rollingBack,
  error,
  onRollback,
}: {
  conversationId: string | null;
  checkpointConversationId: string | null;
  runId: string | null;
  busy: boolean;
  rollingBack: boolean;
  error: boolean;
  onRollback(conversationId: string): Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const confirmationId = useId();
  if (!runId || !conversationId || checkpointConversationId !== conversationId) return null;
  return (
    <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <output>{getChatLabel("chat.checkpoint.hint")}</output>
        <Button
          size="sm"
          disabled={busy}
          aria-expanded={confirm}
          aria-controls={confirm ? confirmationId : undefined}
          onClick={() => setConfirm(!confirm)}
        >
          {getChatLabel(rollingBack ? "chat.checkpoint.busy" : "chat.checkpoint.action")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {getChatLabel("chat.checkpoint.failed")}
        </p>
      ) : null}
      {confirm ? (
        <div id={confirmationId} className="mt-3 border-t border-amber-200 pt-3">
          <p className="font-medium">{getChatLabel("chat.checkpoint.title")}</p>
          <p role="alert" className="mt-1 leading-relaxed">
            {getChatLabel("chat.checkpoint.description")}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              {getChatLabel("chat.checkpoint.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                void onRollback(conversationId);
              }}
            >
              {getChatLabel("chat.checkpoint.confirm")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
