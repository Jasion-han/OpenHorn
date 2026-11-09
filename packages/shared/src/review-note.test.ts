import { expect, test } from "bun:test";
import { JEV_MODEL, JEV_RESOLVED_MODEL } from "./decisions";
import {
  buildReviewNoteRequest,
  noteSupportVerdict,
  REVIEW_NOTE_POLICY,
  requestModelForNoteVerification,
  validateStoredNoteVerification,
} from "./review-note";

const base = {
  requestId: "request-1234567890",
  annotationRevision: 1,
  model: "jev-1.14.0",
  questionVersion: "review-note-v1",
  checkedAt: "2026-11-09T00:00:00.000Z",
  probability: 0.9,
  verdict: "supported",
  usage: { inputTokens: 300, outputTokens: 8 },
  latencyMs: 300,
};
test("new requests ask for facts and their support while explicit v1 requests remain reproducible", () => {
  expect(REVIEW_NOTE_POLICY.questionVersion).toBe("review-note-v2");
  const current = buildReviewNoteRequest("review", "note");
  expect(Object.keys(current.questions).sort()).toEqual(["hasClaims", "note"]);
  const old = buildReviewNoteRequest("review", "note", { version: "review-note-v1" });
  expect(Object.keys(old.questions)).toEqual(["note"]);
  expect(old.model).toBe("jev-1.14.0");
});
test("no factual claims and uncertain existence do not become false warnings or verified content", () => {
  expect(noteSupportVerdict(0.01, 0.1)).toBe("not_applicable");
  expect(noteSupportVerdict(0.99, 0.1)).toBe("not_applicable");
  expect(noteSupportVerdict(0.01, 0.5)).toBe("uncertain");
  expect(noteSupportVerdict(0.99, 0.5)).toBe("uncertain");
  expect(noteSupportVerdict(0.01, 0.9)).toBe("review");
  expect(noteSupportVerdict(0.99, 0.9)).toBe("supported");
  expect(() => noteSupportVerdict(0.9, NaN)).toThrow();
});
test("v1 checks remain readable and v2 requires both probabilities and the derived verdict", () => {
  expect(validateStoredNoteVerification(base, 1)).toEqual(base);
  const current = {
    ...base,
    questionVersion: "review-note-v2",
    hasClaimsProbability: 0.1,
    verdict: "not_applicable",
  };
  expect(validateStoredNoteVerification(current, 1)).toEqual(current);
  for (const bad of [
    { ...current, verdict: "supported" },
    { ...base, questionVersion: "review-note-v2" },
    { ...current, hasClaimsProbability: -0.1 },
    { ...current, hasClaimsProbability: NaN },
  ])
    expect(() => validateStoredNoteVerification(bad, 1)).toThrow();
});
test("cached request model reconstructs the actual provider alias", () => {
  expect(requestModelForNoteVerification(JEV_RESOLVED_MODEL)).toBe(JEV_MODEL);
  expect(
    buildReviewNoteRequest("r", "n", { model: requestModelForNoteVerification(JEV_RESOLVED_MODEL) })
      .model,
  ).toBe(JEV_MODEL);
  expect(requestModelForNoteVerification("jev-1.14.0")).toBe("jev-1.14.0");
  expect(() => requestModelForNoteVerification("unknown-model")).toThrow();
});
