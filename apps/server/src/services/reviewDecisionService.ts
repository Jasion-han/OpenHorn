import { reviewWorkspaces } from "db";
import { and, eq } from "drizzle-orm";
import { reviewDecisionRequest } from "shared/decision-questions";
import {
  choiceValue,
  JEV_MAX_REQUEST_BYTES,
  JEV_QUESTION_VERSION,
  JEV_RESOLVED_MODEL,
  JEV_TOPIC_PREFIX,
  JEV_TOPICS,
  noulValue,
  probabilityVerdict,
} from "shared/decisions";
import { applyReviewResults, REVIEW_LIMITS, validateReviewData } from "shared/reviews";
import type {
  DecisionFailure,
  ReviewDecisionMetadata,
  ReviewResult,
  ReviewRun,
  ReviewSentiment,
  ReviewWorkspace,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { evaluateDecision } from "./decisionClient";
import { getReviewWorkspace, ReviewWorkspaceError } from "./reviewWorkspaceService";

type Writer = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function updateWorkspace(
  tx: Writer,
  userId: string,
  id: string,
  work: (workspace: ReviewWorkspace) => void,
) {
  const row = (
    await tx
      .select()
      .from(reviewWorkspaces)
      .where(and(eq(reviewWorkspaces.id, id), eq(reviewWorkspaces.userId, userId)))
      .limit(1)
  )[0];
  if (!row) throw new ReviewWorkspaceError("review_not_found", 404);
  const data = validateReviewData(JSON.parse(row.data));
  const workspace: ReviewWorkspace = {
    id,
    title: row.title,
    revision: row.revision,
    data,
    rowCount: data.rows.length,
    annotatedCount: data.rows.filter((r) => r.annotation).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  work(workspace);
  const validated = validateReviewData(workspace.data),
    now = new Date();
  const changed = await tx
    .update(reviewWorkspaces)
    .set({ data: JSON.stringify(validated), revision: row.revision + 1, updatedAt: now })
    .where(
      and(
        eq(reviewWorkspaces.id, id),
        eq(reviewWorkspaces.userId, userId),
        eq(reviewWorkspaces.revision, row.revision),
      ),
    );
  if (changed.rowsAffected !== 1) throw new ReviewWorkspaceError("review_conflict", 409);
  return {
    ...workspace,
    revision: row.revision + 1,
    updatedAt: now.toISOString(),
    annotatedCount: validated.rows.filter((r) => r.annotation).length,
  };
}
const inflight = new Map<string, Promise<{ workspace: ReviewWorkspace; run: ReviewRun }>>();
export function classifyReviewBatch(
  userId: string,
  id: string,
  value: unknown,
  evaluate: typeof evaluateDecision = evaluateDecision,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  const input = value as { requestId: string; expectedRevision: number; rowIds: string[] };
  if (
    typeof input.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.requestId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !Array.isArray(input.rowIds) ||
    !input.rowIds.length ||
    input.rowIds.length > REVIEW_LIMITS.batchRows ||
    input.rowIds.some((rowId) => typeof rowId !== "string") ||
    new Set(input.rowIds).size !== input.rowIds.length
  )
    throw new ReviewWorkspaceError("review_invalid_data", 400);
  const key = `${userId}:${id}:${input.requestId}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async () => {
    let workspace = await getReviewWorkspace(userId, id);
    const previous = workspace.data.runs.find((run) => run.requestId === input.requestId);
    if (previous) {
      if (previous.engine !== "jev") throw new ReviewWorkspaceError("review_invalid_data", 400);
      return { workspace, run: previous };
    }
    if (workspace.revision !== input.expectedRevision)
      throw new ReviewWorkspaceError("review_conflict", 409);
    if (workspace.data.runs.length >= REVIEW_LIMITS.runs)
      throw new ReviewWorkspaceError("review_invalid_data", 400);
    const inputs = input.rowIds.map((rowId) => {
      const row = workspace.data.rows.find((row) => row.id === rowId);
      if (!row) throw new ReviewWorkspaceError("review_not_found", 404);
      return { id: row.id, text: row.text, rating: row.rating, revision: row.annotationRevision };
    });
    const run: ReviewRun = {
      id: generateId(),
      requestId: input.requestId,
      engine: "jev",
      decision: {
        status: "pending",
        questionVersion: JEV_QUESTION_VERSION,
        model: JEV_RESOLVED_MODEL,
      },
      conversationId: null,
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
      importedAt: null,
      inputs,
      instructions: JEV_QUESTION_VERSION,
      results: null,
      applied: 0,
      skipped: 0,
    };
    workspace = await db.transaction((tx) =>
      updateWorkspace(tx, userId, id, (current) => {
        if (current.revision !== input.expectedRevision)
          throw new ReviewWorkspaceError("review_conflict", 409);
        current.data.runs.push(run);
        // Reserve room for bounded probabilities before contacting the paid API.
        if (
          Buffer.byteLength(JSON.stringify(current.data), "utf8") + 24_000 >
          REVIEW_LIMITS.documentBytes
        )
          throw new ReviewWorkspaceError("review_invalid_data", 400);
      }),
    );
    const results: ReviewResult[] = [];
    const rowDecisions: NonNullable<ReviewDecisionMetadata["rows"]> = Object.create(null);
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let failure: DecisionFailure | undefined;
    for (let offset = 0; offset < inputs.length; ) {
      const live = await getReviewWorkspace(userId, id);
      if (live.data.runs.find((item) => item.id === run.id)?.decision?.status !== "pending")
        throw new ReviewWorkspaceError("review_conflict", 409);
      let end = Math.min(inputs.length, offset + 6);
      while (
        end > offset &&
        Buffer.byteLength(
          JSON.stringify(reviewDecisionRequest(inputs.slice(offset, end))),
          "utf8",
        ) > JEV_MAX_REQUEST_BYTES
      )
        end--;
      if (end === offset) {
        failure = "input_limit";
        break;
      }
      const batch = inputs.slice(offset, end);
      const result = await evaluate(userId, "reviews", reviewDecisionRequest(batch));
      if (result.ok === false) {
        failure = result.reason;
        break;
      }
      const evaluation = result.evaluation;
      usage.inputTokens += evaluation.usage.inputTokens;
      usage.outputTokens += evaluation.usage.outputTokens;
      usage.costUsd += evaluation.billedCostUsd;
      batch.forEach((row, index) => {
        const interpretable = probabilityVerdict(
          noulValue(evaluation.answers, `r${index}_interpretable`),
        );
        const sentimentAnswer = choiceValue(evaluation.answers, `r${index}_sentiment`);
        const sentimentProbability = sentimentAnswer.probabilities[sentimentAnswer.choice];
        const sentiment: ReviewSentiment =
          interpretable !== "yes" || sentimentProbability < 0.7
            ? "unknown"
            : (sentimentAnswer.choice as ReviewSentiment);
        const topicProbabilities = Object.fromEntries(
          JEV_TOPICS.map((topic) => [topic, noulValue(evaluation.answers, `r${index}_${topic}`)]),
        );
        const selected =
          interpretable === "yes"
            ? JEV_TOPICS.filter(
                (topic) => probabilityVerdict(topicProbabilities[topic]) === "yes",
              ).sort((a, b) => topicProbabilities[b] - topicProbabilities[a])
            : [];
        const needsReview =
          interpretable === "uncertain" ||
          (interpretable === "yes" && sentiment === "unknown") ||
          selected.length > 5 ||
          (interpretable === "yes" &&
            Object.values(topicProbabilities).some((p) => probabilityVerdict(p) === "uncertain"));
        rowDecisions[row.id] = { sentimentProbability, topicProbabilities, needsReview };
        results.push({
          id: row.id,
          sentiment,
          topics: selected.slice(0, 5).map((topic) => `${JEV_TOPIC_PREFIX}${topic}`),
          quote: "",
          note: "",
        });
      });
      offset = end;
    }
    workspace = await db.transaction((tx) =>
      updateWorkspace(tx, userId, id, (current) => {
        const target = current.data.runs.find((item) => item.id === run.id);
        if (!target || target.engine !== "jev" || target.decision?.status !== "pending")
          throw new ReviewWorkspaceError("review_conflict", 409);
        if (failure) {
          target.decision = { ...target.decision, status: "failed", error: failure, usage };
          return;
        }
        target.decision = { ...target.decision, status: "completed", rows: rowDecisions, usage };
        const merged = results.map((result) => {
          const existing = current.data.rows.find((row) => row.id === result.id)?.annotation;
          return { ...result, quote: existing?.quote ?? "", note: existing?.note ?? "" };
        });
        current.data = applyReviewResults(
          current.data,
          run.id,
          merged,
          null,
          new Date().toISOString(),
        );
      }),
    );
    return { workspace, run: workspace.data.runs.find((item) => item.id === run.id) as ReviewRun };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
