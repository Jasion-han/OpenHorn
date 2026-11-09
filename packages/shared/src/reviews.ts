import { validateReviewDecisionMetadata } from "./decisions";
import { validateStoredNoteVerification } from "./review-note";
import type {
  ReviewAnnotation,
  ReviewData,
  ReviewDelimiter,
  ReviewResult,
  ReviewRun,
} from "./types/reviews";

export const REVIEW_LIMITS = {
  csvBytes: 2 * 1024 * 1024,
  documentBytes: 12 * 1024 * 1024,
  rows: 1000,
  columns: 50,
  cellChars: 20000,
  textChars: 8000,
  ratingChars: 200,
  batchRows: 20,
  batchChars: 24000,
  runs: 50,
} as const;
export const REVIEW_JSON_SYSTEM_TAG = "[OpenHorn review classification JSON v1]";
export const REVIEW_SENTIMENTS = ["positive", "neutral", "negative", "mixed", "unknown"] as const;
export class ReviewValidationError extends Error {
  constructor(
    readonly code:
      | "review_invalid_csv"
      | "review_limit"
      | "review_invalid_data"
      | "review_invalid_result" = "review_invalid_data",
  ) {
    super(code);
  }
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function reject(code?: ReviewValidationError["code"]): never {
  throw new ReviewValidationError(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    return reject();
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return reject();
  return value;
}
function reference(value: unknown): string | null {
  return value === null ? null : text(value, 200, true);
}
function date(value: unknown): string {
  const result = text(value, 40, true);
  if (!Number.isFinite(Date.parse(result))) return reject();
  return result;
}

/** RFC-style CSV parser: quoted delimiters/newlines, escaped quotes, no silent repair. */
export function parseReviewCsv(csv: string, delimiter: ReviewDelimiter) {
  if (typeof csv !== "string" || ![",", ";", "\t"].includes(delimiter))
    return reject("review_invalid_csv");
  if (bytes(csv) > REVIEW_LIMITS.csvBytes) return reject("review_limit");
  const source = csv.replace(/^\uFEFF/, "");
  if (source.includes("\0")) return reject("review_invalid_csv");
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const field = () => {
    if (cell.length > REVIEW_LIMITS.cellChars) return reject("review_limit");
    cells.push(cell);
    if (cells.length > REVIEW_LIMITS.columns) return reject("review_limit");
    cell = "";
    closed = false;
  };
  const row = () => {
    field();
    records.push(cells);
    cells = [];
    // Empty source records count too: a file of millions of newlines is not cheap input.
    if (records.length > 10001) return reject("review_limit");
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === delimiter) field();
    else if (ch === "\r" || ch === "\n") {
      row();
      if (ch === "\r" && source[i + 1] === "\n") i++;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || ch === '"') return reject("review_invalid_csv");
      cell += ch;
    }
    if (cell.length > REVIEW_LIMITS.cellChars) return reject("review_limit");
  }
  if (quoted) return reject("review_invalid_csv");
  if (cell || cells.length || closed) row();
  const headers = records.shift();
  if (!headers?.length) return reject("review_invalid_csv");
  const rows = records.map((record, i) => {
    if (record.length > headers.length) return reject("review_invalid_csv");
    return {
      sourceRow: i + 2,
      cells: Array.from({ length: headers.length }, (_, j) => record[j] ?? ""),
    };
  });
  return { headers, rows };
}

export function createReviewData(value: unknown): ReviewData {
  const input = object(value);
  const csv = text(input.csv, REVIEW_LIMITS.csvBytes);
  const fileName = text(input.fileName, 200, true);
  const delimiter = input.delimiter as ReviewDelimiter;
  const parsed = parseReviewCsv(csv, delimiter);
  const textColumn = integer(input.textColumn);
  const ratingColumn = input.ratingColumn == null ? null : integer(input.ratingColumn);
  if (
    textColumn >= parsed.headers.length ||
    (ratingColumn !== null && ratingColumn >= parsed.headers.length)
  )
    return reject();
  const rows: ReviewData["rows"] = [];
  let skippedRows = 0;
  for (const record of parsed.rows) {
    const content = record.cells[textColumn];
    if (!content.trim()) {
      skippedRows++;
      continue;
    }
    if (content.length > REVIEW_LIMITS.textChars || rows.length >= REVIEW_LIMITS.rows)
      return reject("review_limit");
    const rating = ratingColumn === null ? "" : record.cells[ratingColumn];
    if (rating.length > REVIEW_LIMITS.ratingChars) return reject("review_limit");
    rows.push({
      id: `r${record.sourceRow}`,
      sourceRow: record.sourceRow,
      text: content,
      rating,
      annotation: null,
      annotationRevision: 0,
    });
  }
  if (!rows.length) return reject("review_invalid_csv");
  return {
    schemaVersion: 1,
    source: { csv, fileName, delimiter, textColumn, ratingColumn },
    skippedRows,
    rows,
    runs: [],
  };
}

export function validateReviewResult(value: unknown, sourceText: string): ReviewResult {
  const input = object(value);
  if (!REVIEW_SENTIMENTS.includes(input.sentiment as ReviewResult["sentiment"]))
    return reject("review_invalid_result");
  if (!Array.isArray(input.topics) || input.topics.length > 5)
    return reject("review_invalid_result");
  const topics = input.topics.map((topic) => text(topic, 50, true));
  if (new Set(topics).size !== topics.length) return reject("review_invalid_result");
  const quote = text(input.quote, 160);
  if (quote && !sourceText.includes(quote)) return reject("review_invalid_result");
  return {
    id: text(input.id, 30, true),
    sentiment: input.sentiment as ReviewResult["sentiment"],
    topics,
    quote,
    note: text(input.note, 400),
  };
}

export function parseReviewResults(raw: string, run: ReviewRun): ReviewResult[] {
  if (typeof raw !== "string" || raw.length > 128000) return reject("review_invalid_result");
  let value: Record<string, unknown>;
  try {
    const trimmed = raw.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    value = object(JSON.parse(fence ? fence[1] : trimmed));
    if (
      value.runId !== run.id ||
      !Array.isArray(value.results) ||
      value.results.length !== run.inputs.length
    )
      return reject("review_invalid_result");
    const expected = new Map(run.inputs.map((row) => [row.id, row.text]));
    const result = value.results.map((entry) => {
      const id = object(entry).id;
      if (typeof id !== "string" || !expected.has(id)) return reject("review_invalid_result");
      const source = expected.get(id) as string;
      expected.delete(id);
      return validateReviewResult(entry, source);
    });
    return result;
  } catch {
    return reject("review_invalid_result");
  }
}

export function validateReviewData(value: unknown): ReviewData {
  const input = object(value);
  if (bytes(JSON.stringify(value)) > REVIEW_LIMITS.documentBytes) return reject("review_limit");
  if (input.schemaVersion !== 1) return reject();
  const result = createReviewData(input.source);
  if (
    !Array.isArray(input.rows) ||
    input.rows.length !== result.rows.length ||
    input.skippedRows !== result.skippedRows
  )
    return reject();
  result.rows = result.rows.map((source, i) => {
    const row = object((input.rows as unknown[])[i]);
    for (const key of ["id", "text", "rating", "sourceRow"] as const)
      if (source[key] !== row[key]) return reject();
    const annotationRevision = integer(row.annotationRevision);
    let annotation: ReviewAnnotation | null = null;
    if (row.annotation !== null) {
      const raw = object(row.annotation);
      const validated = validateReviewResult({ ...raw, id: source.id }, source.text);
      if (raw.source !== "ai" && raw.source !== "manual") return reject();
      const { id: _id, ...fields } = validated;
      annotation = { ...fields, source: raw.source, runId: reference(raw.runId) };
      if (!annotationRevision || (annotation.source === "manual" && annotation.runId !== null))
        return reject();
    } else if (annotationRevision !== 0) return reject();
    let noteVerification: ReturnType<typeof validateStoredNoteVerification> | undefined;
    if (row.noteVerification !== undefined) {
      if (!annotation?.note.trim()) return reject();
      try {
        noteVerification = validateStoredNoteVerification(row.noteVerification, annotationRevision);
      } catch {
        return reject();
      }
    }
    return {
      ...source,
      annotationRevision,
      annotation,
      ...(noteVerification ? { noteVerification } : {}),
    };
  });
  if (!Array.isArray(input.runs) || input.runs.length > REVIEW_LIMITS.runs) return reject();
  const runIds = new Set<string>();
  const requests = new Set<string>();
  const records = new Map(result.rows.map((row) => [row.id, row]));
  result.runs = input.runs.map((value) => {
    const raw = object(value);
    const id = text(raw.id, 200, true),
      requestId = text(raw.requestId, 128, true);
    if (runIds.has(id) || requests.has(requestId)) return reject();
    runIds.add(id);
    requests.add(requestId);
    if (
      !Array.isArray(raw.inputs) ||
      !raw.inputs.length ||
      raw.inputs.length > REVIEW_LIMITS.batchRows
    )
      return reject();
    const ids = new Set<string>();
    const inputs = raw.inputs.map((value) => {
      const entry = object(value),
        row = records.get(String(entry.id));
      const revision = integer(entry.revision);
      if (
        !row ||
        ids.has(row.id) ||
        row.text !== entry.text ||
        row.rating !== entry.rating ||
        revision > row.annotationRevision
      )
        return reject();
      ids.add(row.id);
      return { id: row.id, text: row.text, rating: row.rating, revision };
    });
    if (reviewBatchChars(inputs) > REVIEW_LIMITS.batchChars) return reject();
    const run: ReviewRun = {
      id,
      requestId,
      inputs,
      conversationId: reference(raw.conversationId),
      sourceMessageId: reference(raw.sourceMessageId),
      createdAt: date(raw.createdAt),
      importedAt: raw.importedAt === null ? null : date(raw.importedAt),
      instructions: text(raw.instructions, 6000, true),
      results: null,
      applied: integer(raw.applied),
      skipped: integer(raw.skipped),
    };
    if (raw.engine !== undefined) {
      if (raw.engine !== "jev" || raw.conversationId !== null || raw.sourceMessageId !== null)
        return reject();
      run.engine = "jev";
      try {
        run.decision = validateReviewDecisionMetadata(
          raw.decision,
          inputs.map((row) => row.id),
        );
      } catch {
        return reject();
      }
      if ((run.decision.status === "completed") !== (raw.results !== null)) return reject();
    } else if (raw.decision !== undefined) return reject();
    if (raw.results !== null)
      run.results = parseReviewResults(JSON.stringify({ runId: id, results: raw.results }), run);
    if (
      (run.results === null) !== (run.importedAt === null) ||
      (run.results ? run.applied + run.skipped !== inputs.length : run.applied + run.skipped !== 0)
    )
      return reject();
    return run;
  });
  for (const row of result.rows)
    if (
      row.annotation?.source === "ai" &&
      (!row.annotation.runId || !runIds.has(row.annotation.runId))
    )
      return reject();
  return result;
}

export function applyReviewResults(
  data: ReviewData,
  runId: string,
  results: ReviewResult[],
  sourceMessageId: string | null,
  importedAt: string,
): ReviewData {
  const run = data.runs.find((run) => run.id === runId);
  if (!run) return reject();
  if (run.results) return data;
  const validated = parseReviewResults(JSON.stringify({ runId, results }), run);
  const output = structuredClone(data);
  const nextRun = output.runs.find((item) => item.id === runId) as ReviewRun;
  const inputs = new Map(run.inputs.map((row) => [row.id, row]));
  const byId = new Map(validated.map((row) => [row.id, row]));
  for (const row of output.rows) {
    const result = byId.get(row.id);
    if (!result) continue;
    if (row.annotationRevision !== inputs.get(row.id)?.revision) {
      nextRun.skipped++;
      continue;
    }
    const { id: _id, ...fields } = result;
    row.annotation = { ...fields, source: "ai", runId };
    row.annotationRevision++;
    delete row.noteVerification;
    nextRun.applied++;
  }
  nextRun.results = validated;
  nextRun.sourceMessageId = sourceMessageId;
  nextRun.importedAt = importedAt;
  return output;
}

export function buildReviewPrompt(run: ReviewRun, instructions = run.instructions): string {
  return `${instructions}\n\n${JSON.stringify({ runId: run.id, reviews: run.inputs.map(({ id, text, rating }) => ({ id, text, rating })), output: { runId: run.id, results: [{ id: run.inputs[0]?.id, sentiment: "positive|neutral|negative|mixed|unknown", topics: [], quote: "", note: "" }] } }, null, 2)}`;
}

/** Budget the actual JSON data payload, including ratings, IDs and escaping. */
export function reviewBatchChars(
  rows: Array<{ id: string; text: string; rating: string }>,
): number {
  return rows.length
    ? JSON.stringify(rows.map(({ id, text, rating }) => ({ id, text, rating }))).length
    : 0;
}

/** A leading apostrophe neutralizes formulas, including whitespace/control prefixes. */
function csvCell(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 whitespace must not hide spreadsheet formula prefixes
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function reviewCsv(data: ReviewData, headers: string[]): string {
  return `\uFEFF${[headers, ...data.rows.map((row) => [String(row.sourceRow), row.text, row.rating, row.annotation?.sentiment ?? "", row.annotation?.topics.join("; ") ?? "", row.annotation?.quote ?? "", row.annotation?.note ?? "", row.annotation?.source ?? ""])].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Reports are factual snapshots; labels are localized by the caller. */
export function reviewReport(
  title: string,
  data: ReviewData,
  labels: {
    total: string;
    annotated: string;
    sentiment: string;
    topics: string;
    evidence: string;
    source: string;
    sentiments: Record<string, string>;
    sources: Record<string, string>;
  },
): string {
  const literal = (value: string) => value.replace(/[\\`*_{}[\]()<>#+!|]/g, "\\$&");
  const annotated = data.rows.filter((row) => row.annotation);
  const topics = new Map<string, number>();
  for (const row of annotated)
    for (const topic of row.annotation?.topics ?? [])
      topics.set(topic, (topics.get(topic) ?? 0) + 1);
  return [
    `# ${literal(title)}`,
    `${labels.total}: ${data.rows.length} · ${labels.annotated}: ${annotated.length}/${data.rows.length}`,
    `## ${labels.sentiment}`,
    ...REVIEW_SENTIMENTS.map(
      (value) =>
        `- ${labels.sentiments[value]}: ${annotated.filter((row) => row.annotation?.sentiment === value).length}`,
    ),
    `## ${labels.topics}`,
    ...[...topics]
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => `- ${literal(topic)}: ${count}`),
    `## ${labels.evidence}`,
    ...data.rows.map((row) =>
      [
        `### ${row.id}`,
        row.text
          .split(/\r?\n/)
          .map((line) => `> ${literal(line)}`)
          .join("\n"),
        row.annotation
          ? `${labels.sentiments[row.annotation.sentiment]} · ${row.annotation.topics.map(literal).join(" / ")}\n\n${literal(row.annotation.quote)}\n\n${literal(row.annotation.note)}\n\n${labels.source}: ${labels.sources[row.annotation.source]}${row.annotation.runId ? ` (${literal(row.annotation.runId)})` : ""}`
          : labels.sources.unannotated,
      ].join("\n\n"),
    ),
  ].join("\n\n");
}
