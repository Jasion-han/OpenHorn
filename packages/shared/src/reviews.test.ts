import { expect, test } from "bun:test";
import { REVIEW_NOTE_POLICY } from "./review-note";
import {
  applyReviewResults,
  createReviewData,
  parseReviewCsv,
  parseReviewResults,
  reviewBatchChars,
  reviewCsv,
  validateReviewData,
} from "./reviews";
import type { ReviewRun } from "./types/reviews";

const input = {
  csv: '\uFEFFtext,rating,other\r\n"Great, but ""slow""\nshipping",4,\r\n,3,\r\nBad,1,\r\nBad,1,\r\n',
  fileName: "reviews.csv",
  delimiter: "," as const,
  textColumn: 0,
  ratingColumn: 1,
};

function fixture() {
  const data = createReviewData(input);
  const run: ReviewRun = {
    id: "run-1",
    requestId: "request-1234567890",
    conversationId: "conversation-1",
    sourceMessageId: null,
    createdAt: "2026-11-09T00:00:00.000Z",
    importedAt: null,
    instructions: "Classify reviews.",
    inputs: data.rows.slice(0, 2).map((row) => ({
      id: row.id,
      text: row.text,
      rating: row.rating,
      revision: row.annotationRevision,
    })),
    results: null,
    applied: 0,
    skipped: 0,
  };
  data.runs.push(run);
  const result = {
    runId: run.id,
    results: run.inputs.map((row) => ({
      id: row.id,
      sentiment: "mixed",
      topics: ["delivery"],
      quote: row.text.slice(0, 10),
      note: "Evidence-based label",
    })),
  };
  return { data, run, result };
}

test("CSV preserves quoted newlines, BOM, duplicate comments and source row identities", () => {
  const parsed = parseReviewCsv(input.csv, ",");
  expect(parsed.headers).toEqual(["text", "rating", "other"]);
  const data = createReviewData(input);
  expect(data.rows.map((row) => [row.id, row.text, row.rating])).toEqual([
    ["r2", 'Great, but "slow"\nshipping', "4"],
    ["r4", "Bad", "1"],
    ["r5", "Bad", "1"],
  ]);
  expect(data.skippedRows).toBe(1);
  expect(data.source.csv).toBe(input.csv);
  expect(validateReviewData(JSON.parse(JSON.stringify(data)))).toEqual(data);
  expect(parseReviewCsv('a;a;\n"x;y";2;', ";").headers).toEqual(["a", "a", ""]);
  expect(parseReviewCsv('a\tb\n"x\ty"\t2', "\t").rows[0].cells[0]).toBe("x\ty");
});

test("malformed and excessive CSV never silently drops or truncates data", () => {
  for (const csv of ['text\n"unterminated', 'text\na"b', 'text\n"a"junk', "a,b\nx,y,z"]) {
    expect(() => createReviewData({ ...input, csv })).toThrow();
  }
  expect(() => createReviewData({ ...input, csv: "text\n" })).toThrow();
  expect(() => createReviewData({ ...input, textColumn: 99 })).toThrow();
  expect(() => createReviewData({ ...input, csv: `text\n${"x".repeat(8001)}` })).toThrow();
  expect(() => createReviewData({ ...input, csv: `text\n${"x\n".repeat(1001)}` })).toThrow();
  expect(() => parseReviewCsv("x".repeat(2 * 1024 * 1024 + 1), ",")).toThrow();
});

test("model results require the exact batch identity, complete unique rows and verbatim evidence", () => {
  const { run, result } = fixture();
  expect(
    parseReviewResults(
      `\u0060\u0060\u0060json\n${JSON.stringify(result)}\n\u0060\u0060\u0060`,
      run,
    ),
  ).toHaveLength(2);
  for (const bad of [
    { ...result, runId: "another-run" },
    { ...result, results: result.results.slice(0, 1) },
    { ...result, results: [result.results[0], result.results[0]] },
    { ...result, results: [...result.results, { ...result.results[0], id: "foreign" }] },
    { ...result, results: result.results.map((row) => ({ ...row, quote: "fabricated evidence" })) },
    { ...result, results: result.results.map((row) => ({ ...row, sentiment: "good" })) },
  ]) {
    expect(() => parseReviewResults(JSON.stringify(bad), run)).toThrow();
  }
  expect(() => parseReviewResults(`Commentary ${JSON.stringify(result)}`, run)).toThrow();
});

test("batch import is atomic and skips annotations changed since the input snapshot", () => {
  const { data, run, result } = fixture();
  data.rows[0].annotationRevision = 1;
  const { id: _id, ...fields } = result.results[0];
  data.rows[0].annotation = {
    ...fields,
    sentiment: "negative",
    source: "manual",
    runId: null,
  };
  const parsed = parseReviewResults(JSON.stringify(result), run);
  const next = applyReviewResults(data, run.id, parsed, "message-1", "2026-11-09T01:00:00.000Z");
  expect(next.runs[0].applied).toBe(1);
  expect(next.runs[0].skipped).toBe(1);
  expect(next.rows[0].annotation?.source).toBe("manual");
  expect(next.rows[1].annotation?.source).toBe("ai");
  expect(data.rows[1].annotation).toBe(null);
  expect(applyReviewResults(next, run.id, parsed, "message-1", "later")).toEqual(next);
  expect(validateReviewData(next)).toEqual(next);
  const tampered = structuredClone(next);
  tampered.rows[0].text = "different source";
  expect(() => validateReviewData(tampered)).toThrow();
});

test("CSV export escapes text and neutralizes spreadsheet formula cells", () => {
  const data = createReviewData({ ...input, csv: 'text,rating\n"  =1+1",5\n"a,""b""",2' });
  const csv = reviewCsv(data, [
    "row",
    "text",
    "rating",
    "sentiment",
    "topics",
    "quote",
    "note",
    "source",
  ]);
  expect(csv.includes("'  =1+1")).toBe(true);
  expect(csv.includes('"a,""b"""')).toBe(true);
  expect(parseReviewCsv(csv, ",").rows).toHaveLength(2);
});

test("batch budget includes rating cells and escaped JSON, not just comment text", () => {
  expect(() =>
    createReviewData({ ...input, csv: `text,rating\nshort,${"x".repeat(201)}` }),
  ).toThrow();
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i + 2}`,
    text: "a".repeat(1100),
    rating: "b".repeat(200),
  }));
  expect(reviewBatchChars(rows) > 24000).toBe(true);
  const escaped = [{ id: "r2", text: '"'.repeat(2000), rating: "5" }];
  expect(reviewBatchChars(escaped) > 4000).toBe(true);
});

test("note verification metadata survives a validated round trip and is invalidated by new analysis", () => {
  const { data, run, result } = fixture();
  const initial = applyReviewResults(
    data,
    run.id,
    parseReviewResults(JSON.stringify(result), run),
    "message-1",
    "2026-11-09T01:00:00.000Z",
  );
  initial.rows[0].noteVerification = {
    requestId: "request-1234567890",
    annotationRevision: 1,
    model: REVIEW_NOTE_POLICY.model,
    questionVersion: REVIEW_NOTE_POLICY.questionVersion,
    probability: 0.1,
    hasClaimsProbability: 0.9,
    verdict: "review",
    checkedAt: "2026-11-09T02:00:00.000Z",
    latencyMs: 300,
    usage: { inputTokens: 300, outputTokens: 8 },
  };
  expect(validateReviewData(initial)).toEqual(initial);
  const invalid = structuredClone(initial);
  const invalidVerification = invalid.rows[0].noteVerification;
  if (!invalidVerification) throw new Error("Missing test verification");
  invalidVerification.annotationRevision = 0;
  expect(() => validateReviewData(invalid)).toThrow();
  const nextRun = {
    ...structuredClone(run),
    id: "run-2",
    requestId: "request-2234567890",
    inputs: initial.rows.slice(0, 2).map((row) => ({
      id: row.id,
      text: row.text,
      rating: row.rating,
      revision: row.annotationRevision,
    })),
  };
  initial.runs.push(nextRun);
  const next = applyReviewResults(
    initial,
    nextRun.id,
    parseReviewResults(JSON.stringify({ ...result, runId: nextRun.id }), nextRun),
    "message-2",
    "2026-11-09T03:00:00.000Z",
  );
  expect(next.rows[0].noteVerification).toBe(undefined);
});
