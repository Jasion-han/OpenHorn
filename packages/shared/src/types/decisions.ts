export type JevFeature = "reviews" | "suggestions" | "rerank" | "skills" | "routeShadow";
export type DecisionQuestion = {
  type: "noul" | "choice" | "score";
  instructions: string | Record<string, string>;
  criteria?: Record<string, string> | string[];
};
export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}
export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export interface DecisionEvaluation {
  model: string;
  providerRequestId: string;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  billedCostUsd: number;
  latencyMs: number;
  cached: boolean;
}
export type DecisionFailure =
  | "disabled"
  | "unavailable"
  | "budget"
  | "timeout"
  | "invalid_response"
  | "input_limit"
  | "rate_limited";
export type DecisionResult =
  | { ok: true; evaluation: DecisionEvaluation }
  | { ok: false; reason: DecisionFailure };
export interface JevPreferences {
  enabled: boolean;
  features: Record<JevFeature, boolean>;
}
export interface JevStatus extends JevPreferences {
  shadow?: { compared: number; disagreements: number; unavailable: number };
  configured: boolean;
  model: string;
  day: string;
  dailyLimitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  requests: number;
}
export interface ReviewDecisionMetadata {
  status: "pending" | "completed" | "failed";
  questionVersion: string;
  model: string;
  error?: DecisionFailure;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  rows?: Record<
    string,
    {
      sentimentProbability: number;
      topicProbabilities: Record<string, number>;
      needsReview: boolean;
    }
  >;
}
