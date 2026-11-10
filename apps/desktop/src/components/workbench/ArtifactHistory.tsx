import { useEffect, useRef, useState } from "react";
import type { ArtifactDetail, ArtifactVersion } from "shared/types";
import { Button, Label } from "ui";
import { formatWorkbenchLabel as format, getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";
import { VersionComparisonDisclosure } from "./VersionComparison";
import { VersionRestore } from "./VersionRestore";

export function ArtifactHistory({
  detail,
  busy,
  onSelect,
  onClose,
  onRestore,
}: {
  detail: ArtifactDetail;
  busy: boolean;
  onSelect(version: number): void;
  onClose(): void;
  onRestore(sourceVersion: number, expectedVersion: number): Promise<void>;
}) {
  const [latest, setLatest] = useState<{ version: ArtifactVersion; baseline: number } | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const live = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry refreshes the comparison baseline after an error
  useEffect(() => {
    live.current = true;
    let owned = true;
    setError("");
    setLatest(null);
    void workbenchApi.artifacts
      .detail(detail.artifact.id)
      .then((value) => {
        if (owned) setLatest({ version: value.version, baseline: value.artifact.currentVersion });
      })
      .catch((failure) => {
        if (owned) setError(workbenchError(failure));
      });
    return () => {
      owned = false;
      live.current = false;
    };
  }, [detail.artifact.id, detail.version.version, retry]);
  return (
    <section
      aria-label={label("workbench.artifacts.history")}
      className="space-y-3 border-t pt-3"
      data-testid="artifact-history"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="artifact-version" className="sr-only">
          {label("workbench.artifacts.versions")}
        </Label>
        <select
          id="artifact-version"
          className="h-8 max-w-full rounded-md border bg-background px-2 text-xs"
          value={detail.version.version}
          disabled={busy}
          onChange={(e) => onSelect(Number(e.target.value))}
        >
          {detail.versions.map((v) => (
            <option key={v.version} value={v.version}>
              {format("workbench.artifacts.version", { version: v.version })}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {label("workbench.artifacts.closeHistory")}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
            {label("workbench.versions.refresh")}
          </Button>
        </div>
      ) : !latest ? (
        <output className="text-xs text-muted-foreground">
          {label("workbench.artifacts.loading")}
        </output>
      ) : (
        detail.version.version !== latest.baseline && (
          <>
            <VersionComparisonDisclosure
              before={detail.version.content}
              after={latest.version.content}
            />
            <VersionRestore
              key={`${detail.version.version}:${latest.baseline}`}
              sourceVersion={detail.version.version}
              currentVersion={latest.baseline}
              disabled={busy}
              onRestore={async () => {
                if (live.current) await onRestore(detail.version.version, latest.baseline);
              }}
              onReload={() => setRetry((n) => n + 1)}
            />
          </>
        )
      )}
    </section>
  );
}
