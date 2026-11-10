import { MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { REVIEW_LIMITS, REVIEW_SENTIMENTS, reviewBatchChars } from "shared/reviews";
import type { ReviewRecord, ReviewWorkspace } from "shared/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "ui";
import {
  formatWorkbenchLabel as format,
  getJevLabel,
  getWorkbenchLabel as label,
  presentJevTopic,
} from "../../../lib/i18n/agent";
import { reviewSelectClass } from "./ReviewImportDialog";

export function ReviewDataset({
  workspace,
  busy,
  onEdit,
  onPrepare,
  onClassify,
  jevEnabled,
  model,
  models,
  onModelChange,
}: {
  workspace: ReviewWorkspace;
  busy: boolean;
  onEdit(row: ReviewRecord): void;
  onPrepare(rowIds: string[]): Promise<boolean>;
  onClassify(rowIds: string[]): Promise<boolean>;
  jevEnabled: boolean;
  model: string;
  models: Array<{ value: string; label: string }>;
  onModelChange(model: string): void;
}) {
  const [analysisMode, setAnalysisMode] = useState<"chat" | "jev">("chat");
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState("");
  const [query, setQuery] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [unannotated, setUnannotated] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRows = workspace.data.rows.filter((row) => selected.includes(row.id));
  const chars = reviewBatchChars(selectedRows);
  const pending = useMemo(
    () =>
      new Set(
        workspace.data.runs
          .filter((run) => !run.results && run.decision?.status !== "failed")
          .flatMap((run) => run.inputs.map((row) => row.id)),
      ),
    [workspace.data.runs],
  );
  const candidates = workspace.data.rows.filter((row) => !row.annotation && !pending.has(row.id));
  const rows = workspace.data.rows.filter(
    (row) =>
      (!unannotated || !row.annotation) &&
      (!sentiment || row.annotation?.sentiment === sentiment) &&
      (!query.trim() ||
        `${row.text}\n${row.annotation?.topics.map(presentJevTopic).join(" ") ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pages);
  const nextBatch = () => {
    setResult("");
    const ids: string[] = [];
    const batch: ReviewRecord[] = [];
    for (const row of candidates) {
      if (
        ids.length === REVIEW_LIMITS.batchRows ||
        reviewBatchChars([...batch, row]) > REVIEW_LIMITS.batchChars
      )
        break;
      ids.push(row.id);
      batch.push(row);
    }
    setSelected(ids);
  };
  return (
    <section className="space-y-4">
      <div className="space-y-2" data-testid="review-analysis-toolbar">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {format("reviews.selection", { count: selected.length, chars })}
            {(query || sentiment || unannotated) && (
              <span className="ml-2">{label("reviews.filtersActive")}</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              disabled={
                busy ||
                (selected.length === 0
                  ? !candidates.length
                  : selected.length > REVIEW_LIMITS.batchRows ||
                    chars > REVIEW_LIMITS.batchChars ||
                    workspace.data.runs.length >= REVIEW_LIMITS.runs ||
                    (analysisMode === "jev" ? !jevEnabled : !model))
              }
              onClick={() => {
                setResult("");
                if (!selected.length) {
                  nextBatch();
                  return;
                }
                void (analysisMode === "jev" ? onClassify(selected) : onPrepare(selected)).then(
                  (done) => {
                    if (done) {
                      setSelected([]);
                      if (analysisMode === "jev") setResult(getJevLabel("jev.reviews.completed"));
                    }
                  },
                );
              }}
            >
              {busy
                ? label("reviews.working")
                : !selected.length
                  ? label("reviews.nextBatch")
                  : analysisMode === "jev"
                    ? getJevLabel("jev.reviews.run")
                    : label("reviews.prepare")}
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={label("reviews.analysisMore")}
                >
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setShowSettings((open) => !open)}>
                  {label("reviews.analysisSettings")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!candidates.length} onSelect={nextBatch}>
                  {label("reviews.nextBatch")}
                </DropdownMenuItem>
                {selected.length > 0 && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setSelected([]);
                      setResult("");
                    }}
                  >
                    {label("reviews.clearSelection")}
                  </DropdownMenuItem>
                )}
                {(query || sentiment || unannotated) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        setQuery("");
                        setSentiment("");
                        setUnannotated(false);
                        setPage(1);
                      }}
                    >
                      {label("reviews.clearFilters")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {selected.length > 0 && (analysisMode === "jev" ? !jevEnabled : !model) && (
          <p className="text-xs text-muted-foreground">
            {analysisMode === "jev"
              ? getJevLabel("jev.reviews.disabled")
              : label("reviews.noModel")}
          </p>
        )}
        {result && <output className="block text-xs text-muted-foreground">{result}</output>}
      </div>
      {showSettings && (
        <section
          className="space-y-3 border-y py-3"
          aria-label={label("reviews.analysisSettings")}
          data-testid="review-analysis-settings"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{label("reviews.analysisSettings")}</h3>
            <Button variant="ghost" size="sm" onClick={() => setShowSettings(false)}>
              {label("reviews.closeSettings")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-64"
              aria-label={label("reviews.search")}
              placeholder={label("reviews.search")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <select
              aria-label={label("reviews.sentimentFilter")}
              className={reviewSelectClass}
              value={sentiment}
              onChange={(e) => {
                setSentiment(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{label("reviews.all")}</option>
              {REVIEW_SENTIMENTS.map((value) => (
                <option value={value} key={value}>
                  {label(`reviews.${value}`)}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={unannotated}
                onChange={(e) => {
                  setUnannotated(e.target.checked);
                  setPage(1);
                }}
              />
              {label("reviews.onlyUnannotated")}
            </label>
            {(query || sentiment || unannotated) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setSentiment("");
                  setUnannotated(false);
                  setPage(1);
                }}
              >
                {label("reviews.clearFilters")}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="review-analysis-mode">{label("reviews.analysisMode")}</Label>
            <select
              id="review-analysis-mode"
              className={reviewSelectClass}
              disabled={busy}
              value={analysisMode}
              onChange={(e) => setAnalysisMode(e.target.value as "chat" | "jev")}
            >
              <option value="chat">{label("reviews.chatAnalysis")}</option>
              <option value="jev">{getJevLabel("jev.reviews.run")}</option>
            </select>
            {analysisMode === "chat" && (
              <>
                <Label htmlFor="review-model" className="sr-only">
                  {label("reviews.model")}
                </Label>
                <select
                  id="review-model"
                  disabled={busy}
                  value={model}
                  className={`${reviewSelectClass} w-full sm:w-64`}
                  onChange={(e) => onModelChange(e.target.value)}
                >
                  <option value="">{label("reviews.noModel")}</option>
                  {models.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {analysisMode === "chat"
              ? label("reviews.prepareHint")
              : jevEnabled
                ? label("reviews.jevAnalysisHint")
                : getJevLabel("jev.reviews.disabled")}
          </p>
        </section>
      )}
      {workspace.data.runs.length >= REVIEW_LIMITS.runs && (
        <p className="w-full text-xs text-muted-foreground">{label("reviews.runLimitReached")}</p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[580px] table-fixed text-left text-sm">
          <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-3">
                <span className="sr-only">{label("reviews.row")}</span>
              </th>
              <th className="w-16 px-2 py-3">{label("reviews.row")}</th>
              <th className="w-[44%] px-3 py-3">{label("reviews.text")}</th>
              <th className="w-20 px-2 py-3">{label("reviews.sentiment")}</th>
              <th className="px-3 py-3">{label("reviews.topics")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice((currentPage - 1) * 25, currentPage * 25).map((row) => (
              <tr key={row.id} className="align-top hover:bg-muted/20">
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label={format("reviews.selectRow", { id: row.id })}
                    checked={selected.includes(row.id)}
                    disabled={
                      busy ||
                      (!selected.includes(row.id) &&
                        (selected.length >= REVIEW_LIMITS.batchRows ||
                          reviewBatchChars([...selectedRows, row]) > REVIEW_LIMITS.batchChars))
                    }
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id),
                      )
                    }
                  />
                </td>
                <td className="px-2 py-3 font-mono text-xs text-muted-foreground">{row.id}</td>
                <td className="px-3 py-3">
                  <button
                    type="button"
                    className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={format("reviews.inspect", { id: row.id })}
                    disabled={busy}
                    onClick={() => onEdit(row)}
                  >
                    <span className="line-clamp-3 whitespace-pre-wrap break-words leading-relaxed">
                      {row.text}
                    </span>
                  </button>
                  {row.rating && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {label("reviews.rating")}: {row.rating}
                    </span>
                  )}
                </td>
                <td className="px-2 py-3 text-xs">
                  {label(
                    row.annotation ? `reviews.${row.annotation.sentiment}` : "reviews.unannotated",
                  )}
                  {workspace.data.runs.find((run) => run.id === row.annotation?.runId)?.decision
                    ?.rows?.[row.id]?.needsReview && (
                    <span className="mt-1 block text-muted-foreground">
                      {getJevLabel("jev.reviews.needsReview")}
                    </span>
                  )}
                  {row.annotation?.source === "manual" && (
                    <span className="mt-1 block text-muted-foreground">
                      {label("reviews.manual")}
                    </span>
                  )}
                  {row.noteVerification &&
                    row.noteVerification.verdict !== "supported" &&
                    row.noteVerification.verdict !== "not_applicable" && (
                      <span className="mt-1 block text-muted-foreground">
                        {label(`reviews.check.${row.noteVerification.verdict}`)}
                      </span>
                    )}
                </td>
                <td className="px-3 py-3 text-xs leading-relaxed">
                  {row.annotation?.topics.map(presentJevTopic).join(" / ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {label("reviews.noMatches")}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{format("reviews.page", { page: currentPage, pages, count: rows.length })}</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {label("reviews.previous")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            {label("reviews.next")}
          </Button>
        </div>
      </div>
    </section>
  );
}
