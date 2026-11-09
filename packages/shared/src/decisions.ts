import type {
  DecisionAnswer,
  DecisionEvaluation,
  DecisionRequest,
  JevFeature,
} from "./types/decisions";

export const JEV_MODEL = "typesafe/jev-1.14";
export const JEV_RESOLVED_MODEL = "typesafe/jev-1.14-20261014";
export const JEV_QUESTION_VERSION = "openhorn-jev-v1";
export const JEV_MAX_REQUEST_BYTES = 28_000;
export const JEV_FEATURES: JevFeature[] = [
  "reviews",
  "suggestions",
  "rerank",
  "skills",
  "routeShadow",
];
export const JEV_TOPICS = [
  "reliability",
  "billing",
  "service",
  "usability",
  "performance",
  "feature",
] as const;
export const JEV_TOPIC_PREFIX = "jev:";
export function probabilityVerdict(probability: number): "yes" | "no" | "uncertain" {
  return probability >= 0.7 ? "yes" : probability <= 0.3 ? "no" : "uncertain";
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid decision response");
  return value as Record<string, unknown>;
};
const number = (value: unknown, max = 1): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
    throw new Error("Invalid decision number");
  return value;
};
export function parseDecisionResponse(
  value: unknown,
  request: DecisionRequest,
): Omit<DecisionEvaluation, "latencyMs" | "cached" | "billedCostUsd"> {
  const data = object(value),
    raw = object(data.answers),
    answers: Record<string, DecisionAnswer> = Object.create(null);
  if (
    data.model !== JEV_RESOLVED_MODEL ||
    typeof data.id !== "string" ||
    !data.id ||
    data.id.length > 200 ||
    Object.keys(raw).length !== Object.keys(request.questions).length
  )
    throw new Error("Invalid decision identity");
  for (const [id, question] of Object.entries(request.questions)) {
    if (!Object.hasOwn(raw, id)) throw new Error("Missing decision answer");
    const answer = object(raw[id]);
    if (answer.type !== question.type) throw new Error("Invalid decision type");
    if (question.type === "noul") answers[id] = { type: "noul", noul: number(answer.noul) };
    else {
      const probabilities = object(answer.probabilities),
        expected = Array.isArray(question.criteria)
          ? question.criteria.map((_, index) => String(index))
          : Object.keys(question.criteria ?? {});
      if (
        !expected.length ||
        Object.keys(probabilities).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(probabilities, key))
      )
        throw new Error("Invalid decision options");
      const normalized: Record<string, number> = Object.create(null);
      for (const key of expected) normalized[key] = number(probabilities[key]);
      if (Math.abs(Object.values(normalized).reduce((sum, n) => sum + n, 0) - 1) > 0.03)
        throw new Error("Invalid probability distribution");
      const confidence = number(answer.confidence);
      if (question.type === "choice") {
        if (
          typeof answer.choice !== "string" ||
          !Object.hasOwn(normalized, answer.choice) ||
          Object.values(normalized).some((n) => n > normalized[answer.choice as string] + 0.011)
        )
          throw new Error("Invalid choice");
        answers[id] = {
          type: "choice",
          choice: answer.choice,
          probabilities: normalized,
          confidence,
        };
      } else
        answers[id] = {
          type: "score",
          score: number(answer.score, expected.length - 1),
          probabilities: normalized,
          confidence,
        };
    }
  }
  const usage = object(data.usage),
    inputTokens = number(usage.input_tokens, 65_536),
    outputTokens = number(usage.output_tokens, 1_000_000),
    costUsd = number(usage.cost, 1);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens))
    throw new Error("Invalid token usage");
  return {
    model: data.model,
    providerRequestId: data.id,
    answers,
    usage: { inputTokens, outputTokens, costUsd },
  };
}
export function noulValue(answers: Record<string, DecisionAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== "noul") throw new Error("Expected Noul");
  return answer.noul;
}
export function choiceValue(answers: Record<string, DecisionAnswer>, id: string) {
  const answer = answers[id];
  if (answer?.type !== "choice") throw new Error("Expected Choice");
  return answer;
}

export function validateReviewDecisionMetadata(value: unknown, ids: string[]) {
  const v = object(value);
  if (
    !["pending", "completed", "failed"].includes(String(v.status)) ||
    v.model !== JEV_RESOLVED_MODEL ||
    v.questionVersion !== JEV_QUESTION_VERSION
  )
    throw new Error("Invalid review decision metadata");
  const result: import("./types/decisions").ReviewDecisionMetadata = {
    status: v.status as "pending" | "completed" | "failed",
    model: v.model,
    questionVersion: v.questionVersion,
  };
  if (v.error !== undefined) {
    if (
      ![
        "disabled",
        "unavailable",
        "budget",
        "timeout",
        "invalid_response",
        "input_limit",
        "rate_limited",
      ].includes(String(v.error))
    )
      throw new Error("Invalid decision failure");
    result.error = v.error as import("./types/decisions").DecisionFailure;
  }
  if (v.usage !== undefined) {
    const usage = object(v.usage);
    result.usage = {
      inputTokens: number(usage.inputTokens, 2_000_000),
      outputTokens: number(usage.outputTokens, 2_000_000),
      costUsd: number(usage.costUsd, 10),
    };
    if (
      !Number.isSafeInteger(result.usage.inputTokens) ||
      !Number.isSafeInteger(result.usage.outputTokens)
    )
      throw new Error("Invalid review usage");
  }
  if (v.rows !== undefined) {
    const rows = object(v.rows);
    if (Object.keys(rows).length !== ids.length || ids.some((id) => !Object.hasOwn(rows, id)))
      throw new Error("Invalid review row decisions");
    const normalizedRows: NonNullable<import("./types/decisions").ReviewDecisionMetadata["rows"]> =
      Object.create(null);
    result.rows = normalizedRows;
    for (const id of ids) {
      const row = object(rows[id]),
        topics = object(row.topicProbabilities);
      if (
        typeof row.needsReview !== "boolean" ||
        Object.keys(topics).length !== JEV_TOPICS.length ||
        JEV_TOPICS.some((topic) => !Object.hasOwn(topics, topic))
      )
        throw new Error("Invalid review topics");
      normalizedRows[id] = {
        sentimentProbability: number(row.sentimentProbability),
        needsReview: row.needsReview,
        topicProbabilities: Object.fromEntries(
          JEV_TOPICS.map((topic) => [topic, number(topics[topic])]),
        ),
      };
    }
  }
  if (
    (result.status === "pending" && (result.rows || result.usage || result.error)) ||
    (result.status === "failed" && (!result.error || result.rows)) ||
    (result.status === "completed" && result.error)
  )
    throw new Error("Inconsistent review decision state");
  if (result.status === "completed" && (!result.rows || !result.usage))
    throw new Error("Incomplete review decision metadata");
  return result;
}
