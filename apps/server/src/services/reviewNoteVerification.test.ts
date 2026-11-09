import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildReviewNoteRequest, noteSupportVerdict, REVIEW_NOTE_POLICY } from "shared/review-note";
import { evaluateReviewNote, parseReviewNoteResponse } from "./reviewNoteVerification";

const good = {
  model: "jev-1.14.0",
  answers: { note: { type: "noul", noul: 0.96 }, hasClaims: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 321, output_tokens: 8 },
};
test("production payload is identical to the recorded successful minimal-input live probe", async () => {
  const records = JSON.parse(
    await readFile(
      new URL(
        "../../../../docs/evaluations/review-jev/note-only-results/live-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const record of records) {
    expect(record.status).toBe(200);
    expect(
      buildReviewNoteRequest(
        record.payload.state.review.text,
        record.payload.state.annotation.note,
        { version: "review-note-v1" },
      ),
    ).toEqual(record.payload);
  }
});
test("note request sends just the review and saved note with the evaluated question", () => {
  const payload = buildReviewNoteRequest("Comment", "Note");
  expect(payload.state).toEqual({ review: { text: "Comment" }, annotation: { note: "Note" } });
  expect(Object.keys(payload.questions)).toEqual(["note", "hasClaims"]);
  expect(payload.model).toBe("jev-1.14.0");
  expect(JSON.stringify(payload).includes("apiKey")).toBe(false);
  expect(noteSupportVerdict(0.3)).toBe("review");
  expect(noteSupportVerdict(0.31)).toBe("uncertain");
  expect(noteSupportVerdict(0.7)).toBe("supported");
  expect(REVIEW_NOTE_POLICY.questionVersion).toBe("review-note-v2");
});
test("current protocol matches every recorded v2 live payload", async () => {
  const records = JSON.parse(
    await readFile(
      new URL(
        "../../../../docs/evaluations/review-jev/v2-results/live-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const record of records) {
    expect(record.status).toBe(200);
    expect(
      buildReviewNoteRequest(
        record.payload.state.review.text,
        record.payload.state.annotation.note,
      ),
    ).toEqual(record.payload);
  }
});
test("a non-factual note never becomes supported or a factual contradiction", async () => {
  for (const [hasClaims, note, verdict] of [
    [0.05, 0.95, "not_applicable"],
    [0.05, 0.05, "not_applicable"],
    [0.5, 0.99, "uncertain"],
  ] as const) {
    const result = await evaluateReviewNote("review", "note", {
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({
          ...good,
          answers: {
            note: { type: "noul", noul: note },
            hasClaims: { type: "noul", noul: hasClaims },
          },
        }),
    });
    expect(result.verdict).toBe(verdict);
  }
});
test("provider response validation rejects bad probabilities, types, versions and usage", () => {
  expect(parseReviewNoteResponse(good)).toEqual({
    model: "jev-1.14.0",
    probability: 0.96,
    hasClaimsProbability: 0.99,
    usage: { inputTokens: 321, outputTokens: 8 },
  });
  for (const bad of [
    null,
    {},
    { ...good, model: "another-model" },
    { ...good, usage: { input_tokens: -1, output_tokens: 3 } },
    ...[NaN, Infinity, -0.01, 1.01, "0.9"].map((noul) => ({
      ...good,
      answers: { note: { type: "noul", noul } },
    })),
    { ...good, answers: { note: { type: "choice", noul: 0.9 } } },
    { ...good, answers: { note: { type: "noul", noul: 0.9 } } },
    { ...good, answers: { ...good.answers, hasClaims: { type: "noul", noul: NaN } } },
  ])
    expect(() => parseReviewNoteResponse(bad)).toThrow();
});
test("successful call returns exact payload, probability and usage without leaking the key", async () => {
  let sent: RequestInit | undefined;
  const result = await evaluateReviewNote("Review", "Saved note", {
    apiKey: "synthetic-key-never-used",
    fetchImpl: async (url, options) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      sent = options;
      return Response.json(good);
    },
  });
  expect(sent?.redirect).toBe("error");
  expect(sent?.signal instanceof AbortSignal).toBe(true);
  expect(JSON.parse(String(sent?.body))).toEqual(result.request);
  expect(result.probability).toBe(0.96);
  expect(result.verdict).toBe("supported");
  expect(JSON.stringify(result).includes("synthetic-key-never-used")).toBe(false);
});
test("empty notes and missing keys never invoke the provider", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json(good);
  };
  for (const [review, note, key] of [
    ["review", "", "test"],
    ["", "note", "test"],
    ["review", "note", ""],
  ])
    await expect(evaluateReviewNote(review, note, { apiKey: key, fetchImpl })).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    evaluateReviewNote("\u0001".repeat(8000), "note", { apiKey: "test", fetchImpl }),
  ).rejects.toMatchObject({ code: "review_verification_input_limit" });
  expect(calls).toBe(0);
});
test("HTTP and transport failures are errors, never unsupported answers, with no automatic retry", async () => {
  let calls = 0;
  for (const status of [401, 403, 429, 500]) {
    await expect(
      evaluateReviewNote("review", "note", {
        apiKey: "test",
        fetchImpl: async () => {
          calls++;
          return new Response("sensitive raw upstream error", { status });
        },
      }),
    ).rejects.toMatchObject({
      code: status === 429 ? "review_verification_rate_limited" : "review_verification_unavailable",
    });
  }
  await expect(
    evaluateReviewNote("review", "note", {
      apiKey: "test",
      fetchImpl: async () => {
        calls++;
        throw new DOMException("timeout", "TimeoutError");
      },
    }),
  ).rejects.toMatchObject({ code: "review_verification_timeout" });
  expect(calls).toBe(5);
});
