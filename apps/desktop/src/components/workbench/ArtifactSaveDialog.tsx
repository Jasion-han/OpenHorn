import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SavedArtifact } from "shared/types";
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
import { formatWorkbenchLabel, getWorkbenchLabel } from "../../lib/i18n/agent";
import { notifySuccess } from "../../lib/notify";
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";

export interface ArtifactSaveDialogProps {
  messageId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}
export function ArtifactSaveDialog({ messageId, onClose, onSaved }: ArtifactSaveDialogProps) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [title, setTitle] = useState("");
  const [artifacts, setArtifacts] = useState<SavedArtifact[]>([]);
  const [targetId, setTargetId] = useState("");
  const [target, setTarget] = useState<SavedArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [targetLoading, setTargetLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const submitting = useRef(false);
  const previousMessage = useRef<string | null>(null);
  const targetRequest = useRef("");
  const listIdentity = useRef("");
  useEffect(() => {
    const request = ++generation.current;
    const requestKey = JSON.stringify([messageId, refresh]);
    listIdentity.current = requestKey;
    if (previousMessage.current !== messageId) {
      setMode("new");
      setTitle("");
      setTargetId("");
      setTarget(null);
      setSaving(false);
      previousMessage.current = messageId;
    }
    setError("");
    if (!messageId) return;
    setLoading(true);
    void workbenchApi.artifacts
      .list()
      .then((response) => {
        if (request === generation.current && listIdentity.current === requestKey)
          setArtifacts(response.artifacts);
      })
      .catch((failure) => {
        if (request === generation.current) setError(workbenchError(failure));
      })
      .finally(() => {
        if (request === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [messageId, refresh]);
  useEffect(() => {
    let cancelled = false;
    const requestKey = JSON.stringify([targetId, refresh]);
    targetRequest.current = requestKey;
    setTarget(null);
    if (mode !== "existing" || !targetId) {
      setTargetLoading(false);
      return;
    }
    setTargetLoading(true);
    void workbenchApi.artifacts
      .detail(targetId)
      .then((response) => {
        if (!cancelled && targetRequest.current === requestKey) setTarget(response.artifact);
      })
      .catch((failure) => {
        if (!cancelled) setError(workbenchError(failure));
      })
      .finally(() => {
        if (!cancelled) setTargetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, targetId, refresh]);
  const save = async () => {
    if (!messageId || submitting.current || (mode === "existing" && !target)) return;
    submitting.current = true;
    const request = generation.current;
    setSaving(true);
    setError("");
    try {
      if (mode === "new")
        await workbenchApi.artifacts.create({
          sourceMessageId: messageId,
          ...(title.trim() ? { title: title.trim() } : {}),
        });
      else if (target)
        await workbenchApi.artifacts.append(target.id, {
          expectedVersion: target.currentVersion,
          sourceMessageId: messageId,
        });
      if (request !== generation.current) return;
      notifySuccess(
        getWorkbenchLabel("workbench.artifacts.saved"),
        getWorkbenchLabel("workbench.artifacts.saveDescription"),
      );
      onSaved?.();
      onClose();
    } catch (failure) {
      if (request === generation.current) setError(workbenchError(failure));
    } finally {
      submitting.current = false;
      if (request === generation.current) setSaving(false);
    }
  };
  return (
    <Dialog
      open={!!messageId}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{getWorkbenchLabel("workbench.artifacts.saveTitle")}</DialogTitle>
          <DialogDescription>
            {getWorkbenchLabel("workbench.artifacts.saveDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={mode === "new" ? "secondary" : "outline"}
              disabled={saving}
              onClick={() => {
                setMode("new");
                setError("");
              }}
            >
              {getWorkbenchLabel("workbench.artifacts.new")}
            </Button>
            <Button
              size="sm"
              variant={mode === "existing" ? "secondary" : "outline"}
              disabled={saving || loading || artifacts.length === 0}
              onClick={() => {
                setMode("existing");
                setError("");
              }}
            >
              {getWorkbenchLabel("workbench.artifacts.existing")}
            </Button>
          </div>
          {mode === "new" ? (
            <div className="space-y-2">
              <Label htmlFor="artifact-save-title">
                {getWorkbenchLabel("workbench.artifacts.name")}
              </Label>
              <Input
                id="artifact-save-title"
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                disabled={saving}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="artifact-save-target">
                {getWorkbenchLabel("workbench.artifacts.target")}
              </Label>
              <select
                id="artifact-save-target"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                disabled={saving || loading}
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setError("");
                }}
              >
                <option value="">{getWorkbenchLabel("workbench.artifacts.chooseTarget")}</option>
                {artifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {artifact.title}
                  </option>
                ))}
              </select>
              {target ? (
                <p className="text-xs text-muted-foreground">
                  {formatWorkbenchLabel("workbench.artifacts.versionHint", {
                    version: target.currentVersion + 1,
                  })}
                </p>
              ) : null}
            </div>
          )}
          {loading || targetLoading ? (
            <output className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {getWorkbenchLabel("workbench.artifacts.loading")}
            </output>
          ) : null}
          {error ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{error}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setRefresh((value) => value + 1)}
              >
                {getWorkbenchLabel("workbench.artifacts.refresh")}
              </Button>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {getWorkbenchLabel("workbench.artifacts.cancel")}
          </Button>
          <Button
            disabled={saving || targetLoading || (mode === "existing" && !target)}
            onClick={() => void save()}
          >
            {saving
              ? getWorkbenchLabel("workbench.artifacts.busy")
              : getWorkbenchLabel("workbench.artifacts.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
