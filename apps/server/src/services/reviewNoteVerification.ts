import { JEV_MODEL } from "shared/decisions";
import { buildReviewNoteRequest, noteSupportVerdict, REVIEW_NOTE_POLICY } from "shared/review-note";
import type { ReviewNoteRequest } from "shared/types";
import { evaluateDecision } from "./decisionClient";
import { getJevApiKey } from "./decisionUsageService";

export const REVIEW_NOTE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export class ReviewNoteVerificationError extends Error {
  constructor(
    readonly code:
      | "review_verification_unavailable"
      | "review_verification_rate_limited"
      | "review_verification_timeout"
      | "review_verification_invalid_response"
      | "review_verification_empty"
      | "review_verification_input_limit",
    readonly status: 400 | 503 | 504 = 503,
  ) {
    super(code);
  }
}
type VerificationFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface ReviewNoteEvaluation {
  request: ReviewNoteRequest;
  model: string;
  probability: number;
  hasClaimsProbability?: number;
  verdict: ReturnType<typeof noteSupportVerdict>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}
function invalid(): never {
  throw new ReviewNoteVerificationError("review_verification_invalid_response");
}
export function parseReviewNoteResponse(
  value: unknown,
): Pick<ReviewNoteEvaluation, "model" | "probability" | "hasClaimsProbability" | "usage"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const data = value as {
    model?: unknown;
    answers?: {
      note?: { type?: unknown; noul?: unknown };
      hasClaims?: { type?: unknown; noul?: unknown };
    };
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const probability = data.answers?.note?.noul;
  const hasClaimsProbability = data.answers?.hasClaims?.noul;
  if (
    data.model !== REVIEW_NOTE_POLICY.model ||
    data.answers?.note?.type !== "noul" ||
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    return invalid();
  if (
    data.answers?.hasClaims?.type !== "noul" ||
    typeof hasClaimsProbability !== "number" ||
    !Number.isFinite(hasClaimsProbability) ||
    hasClaimsProbability < 0 ||
    hasClaimsProbability > 1 ||
    Object.keys(data.answers).length !== 2
  )
    return invalid();
  const input = data.usage?.input_tokens,
    output = data.usage?.output_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > 65536 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    return invalid();
  return {
    model: data.model,
    probability,
    hasClaimsProbability,
    usage: { inputTokens: input, outputTokens: output },
  };
}
export async function evaluateReviewNote(
  text: string,
  note: string,
  options: { apiKey?: string; fetchImpl?: VerificationFetch; userId?: string } = {},
): Promise<ReviewNoteEvaluation> {
  if (!text.trim() || !note.trim())
    throw new ReviewNoteVerificationError("review_verification_empty", 400);
  if (options.userId && getJevApiKey() && !options.fetchImpl && options.apiKey === undefined) {
    const request = buildReviewNoteRequest(text, note, { model: JEV_MODEL });
    const result = await evaluateDecision(options.userId, "reviews", request);
    if (result.ok === false)
      throw new ReviewNoteVerificationError(
        result.reason === "timeout"
          ? "review_verification_timeout"
          : result.reason === "rate_limited"
            ? "review_verification_rate_limited"
            : result.reason === "invalid_response"
              ? "review_verification_invalid_response"
              : "review_verification_unavailable",
        result.reason === "timeout" ? 504 : 503,
      );
    const answer = result.evaluation.answers.note;
    const hasClaims = result.evaluation.answers.hasClaims;
    if (answer.type !== "noul" || hasClaims?.type !== "noul") return invalid();
    return {
      request,
      model: result.evaluation.model,
      probability: answer.noul,
      hasClaimsProbability: hasClaims.noul,
      verdict: noteSupportVerdict(answer.noul, hasClaims.noul),
      usage: {
        inputTokens: result.evaluation.usage.inputTokens,
        outputTokens: result.evaluation.usage.outputTokens,
      },
      latencyMs: result.evaluation.latencyMs,
    };
  }
  const key = (options.apiKey ?? process.env.TYPESAFE_API_KEY)?.trim();
  if (!key) throw new ReviewNoteVerificationError("review_verification_unavailable");
  const request = buildReviewNoteRequest(text, note),
    body = JSON.stringify(request);
  if (Buffer.byteLength(body, "utf8") > 28000)
    throw new ReviewNoteVerificationError("review_verification_input_limit", 400);
  const started = performance.now();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(REVIEW_NOTE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new ReviewNoteVerificationError(
        response.status === 429
          ? "review_verification_rate_limited"
          : "review_verification_unavailable",
      );
    const raw: unknown = await response.json();
    const parsed = parseReviewNoteResponse(raw);
    return {
      request,
      ...parsed,
      verdict: noteSupportVerdict(parsed.probability, parsed.hasClaimsProbability),
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    if (error instanceof ReviewNoteVerificationError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new ReviewNoteVerificationError("review_verification_timeout", 504);
    if (error instanceof SyntaxError) return invalid();
    throw new ReviewNoteVerificationError("review_verification_unavailable");
  }
}
