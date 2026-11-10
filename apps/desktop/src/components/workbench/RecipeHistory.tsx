import { useEffect, useState } from "react";
import type { RecipeVersion, TaskRecipe } from "shared/types";
import { Button, Label } from "ui";
import { formatWorkbenchLabel as format, getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";
import { VersionComparisonDisclosure } from "./VersionComparison";
import { VersionRestore } from "./VersionRestore";

export function RecipeHistory({
  recipe,
  onClose,
  busy,
  onRestore,
}: {
  recipe: TaskRecipe;
  onClose(): void;
  busy: boolean;
  onRestore(sourceVersion: number, expectedVersion: number): Promise<void>;
}) {
  const [versions, setVersions] = useState<RecipeVersion[]>([]);
  const [selected, setSelected] = useState(recipe.version);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(recipe.version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly starts a fresh read after an error
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    void workbenchApi.recipes
      .detail(recipe.id)
      .then((result) => {
        if (!live) return;
        setVersions(result.versions);
        setCurrentVersion(result.recipe.version);
        setSelected((current) =>
          result.versions.some((v) => v.version === current) ? current : result.recipe.version,
        );
      })
      .catch((failure) => {
        if (live) setError(workbenchError(failure));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [recipe.id, retry]);
  const version = versions.find((v) => v.version === selected);
  const current = versions.find((v) => v.version === currentVersion);
  return (
    <section
      aria-label={label("workbench.recipes.history")}
      data-testid="recipe-history"
      className="space-y-3 border-y py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{label("workbench.recipes.history")}</h3>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          {label("workbench.recipes.closeHistory")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{label("workbench.recipes.historyHint")}</p>
      {loading ? (
        <output className="text-sm text-muted-foreground">
          {label("workbench.recipes.loading")}
        </output>
      ) : error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
            {label("workbench.recipes.retry")}
          </Button>
        </div>
      ) : version ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="recipe-history-version">
              {label("workbench.recipes.historyVersion")}
            </Label>
            <select
              id="recipe-history-version"
              disabled={busy}
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {format("workbench.recipes.version", { version: v.version })} ·{" "}
                  {new Date(v.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          <p className="break-words text-sm">{version.spec.title}</p>
          {version.spec.description && (
            <p className="break-words text-sm text-muted-foreground">{version.spec.description}</p>
          )}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{label("workbench.recipes.prompt")}</h4>
            <pre
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs"
              data-testid="recipe-history-prompt"
            >
              {version.spec.promptTemplate}
            </pre>
          </div>
          {version.spec.parameters.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{label("workbench.recipes.parameters")}</h4>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {version.spec.parameters.map((p) => (
                  <li key={p.key}>
                    {p.label} · {p.key}
                    {p.required ? " *" : ""}
                    {p.defaultValue !== undefined ? ` · ${p.defaultValue}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {current && selected !== currentVersion && (
            <>
              <VersionComparisonDisclosure
                before={JSON.stringify(version.spec, null, 2)}
                after={JSON.stringify(current.spec, null, 2)}
              />
              <VersionRestore
                key={`${selected}:${currentVersion}`}
                sourceVersion={selected}
                currentVersion={currentVersion}
                disabled={busy}
                onRestore={() => onRestore(selected, currentVersion)}
                onReload={() => setRetry((n) => n + 1)}
              />
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{label("workbench.recipes.historyEmpty")}</p>
      )}
    </section>
  );
}
