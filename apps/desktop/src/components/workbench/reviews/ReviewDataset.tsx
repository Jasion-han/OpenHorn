import { useMemo, useState } from "react";
import { REVIEW_LIMITS, REVIEW_SENTIMENTS, reviewBatchChars } from "shared/reviews";
import type { ReviewRecord, ReviewWorkspace } from "shared/types";
import { Button, Input } from "ui";
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
}: {
  workspace: ReviewWorkspace;
  busy: boolean;
  onEdit(row: ReviewRecord): void;
  onPrepare(rowIds: string[]): Promise<boolean>;
  onClassify(rowIds: string[]): Promise<boolean>;
  jevEnabled: boolean;
}) {
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !candidates.length}
            onClick={nextBatch}
          >
            {label("reviews.nextBatch")}
          </Button>
          {selected.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected([])}>
              {label("reviews.clearSelection")}
            </Button>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {format("reviews.selection", { count: selected.length, chars })}
          </span>
        </div>
        <Button
          size="sm"
          disabled={
            busy ||
            !selected.length ||
            selected.length > REVIEW_LIMITS.batchRows ||
            chars > REVIEW_LIMITS.batchChars ||
            workspace.data.runs.length >= REVIEW_LIMITS.runs
          }
          onClick={() =>
            void onPrepare(selected).then((done) => {
              if (done) setSelected([]);
            })
          }
        >
          {label(busy ? "reviews.working" : "reviews.prepare")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          title={getJevLabel(jevEnabled ? "jev.reviews.hint" : "jev.reviews.disabled")}
          disabled={
            !jevEnabled ||
            busy ||
            !selected.length ||
            selected.length > REVIEW_LIMITS.batchRows ||
            chars > REVIEW_LIMITS.batchChars ||
            workspace.data.runs.length >= REVIEW_LIMITS.runs
          }
          onClick={() =>
            void onClassify(selected).then((done) => {
              if (done) setSelected([]);
            })
          }
        >
          {getJevLabel("jev.reviews.run")}
        </Button>
        <p className="w-full text-xs leading-relaxed text-muted-foreground">
          {label("reviews.prepareHint")}
        </p>
        {workspace.data.runs.length >= REVIEW_LIMITS.runs && (
          <p className="w-full text-xs text-muted-foreground">{label("reviews.runLimitReached")}</p>
        )}
      </div>
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
