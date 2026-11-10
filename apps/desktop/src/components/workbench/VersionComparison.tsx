import { useMemo, useState } from "react";
import { getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { compareVersions } from "../../lib/versionDiff";

export function VersionComparisonDisclosure(props: { before: string; after: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="border-t pt-3">
      <summary className="cursor-pointer rounded text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {label("workbench.versions.compare")}
      </summary>
      {open && (
        <div className="mt-3">
          <VersionComparison {...props} />
        </div>
      )}
    </details>
  );
}

export function VersionComparison({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => compareVersions(before, after), [before, after]);
  return (
    <div className="space-y-2" data-testid="version-comparison">
      {diff.same ? (
        <p className="text-sm text-muted-foreground">{label("workbench.versions.same")}</p>
      ) : diff.mode === "separate" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {label(diff.truncated ? "workbench.versions.truncated" : "workbench.versions.large")}
          </p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {[
              ["selected", diff.before],
              ["current", diff.after],
            ].map(([key, text]) => (
              <div key={key} className="min-w-0 space-y-1">
                <h4 className="text-xs font-medium">
                  {label(
                    key === "selected"
                      ? "workbench.versions.selected"
                      : "workbench.versions.current",
                  )}
                </h4>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-3 text-xs">
                  {text}
                </pre>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{label("workbench.versions.legend")}</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {diff.lines.map((line) => (
              <span
                key={line.key}
                className={`block ${line.kind === "added" ? "bg-green-500/10" : line.kind === "removed" ? "bg-red-500/10" : ""}`}
              >
                {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
                {line.text}
              </span>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}
