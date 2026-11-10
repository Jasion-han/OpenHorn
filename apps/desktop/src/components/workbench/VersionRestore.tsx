import { useEffect, useRef, useState } from "react";
import { Button } from "ui";
import { formatWorkbenchLabel as format, getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { workbenchError } from "../../lib/workbenchApi";

export function VersionRestore({
  sourceVersion,
  currentVersion,
  disabled,
  onRestore,
  onReload,
}: {
  sourceVersion: number;
  currentVersion: number;
  disabled?: boolean;
  onRestore(): Promise<void>;
  onReload(): void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(false),
    lock = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const restore = async () => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await onRestore();
      if (live.current) setConfirm(false);
    } catch (failure) {
      if (live.current) setError(workbenchError(failure));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t pt-3" data-testid="version-restore">
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={onReload} disabled={busy}>
            {label("workbench.versions.refresh")}
          </Button>
        </div>
      )}
      {confirm ? (
        <>
          <p className="text-sm">
            {format("workbench.versions.restoreHint", {
              source: sourceVersion,
              next: currentVersion + 1,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || disabled} onClick={() => void restore()}>
              {label(busy ? "workbench.versions.restoring" : "workbench.versions.confirm")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              {label("workbench.artifacts.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirm(true)}>
          {label("workbench.versions.restore")}
        </Button>
      )}
    </div>
  );
}
