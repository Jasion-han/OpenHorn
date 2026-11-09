import type {
  CreateReviewWorkspaceInput,
  PreparedReviewRun,
  PrepareReviewRunInput,
  ReviewAnnotation,
  ReviewNoteVerificationResult,
  ReviewWorkspace,
  ReviewWorkspaceSummary,
} from "shared/types";
import { getDesktopBackendBase } from "./backendBase";
import { getWorkbenchLabel as label } from "./i18n/agent";
import { fetchWithBackendStatus } from "./serverApi";

export class ReviewApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetchWithBackendStatus(
    `${getDesktopBackendBase()}/review-workspaces${path}`,
    {
      method,
      credentials: "include",
      ...(data === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ReviewApiError(body.errorCode ?? "review_unavailable");
  return body as T;
}
export function reviewError(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : "review_unavailable";
  switch (code) {
    case "review_verification_unavailable":
      return label("reviews.check.unavailable");
    case "review_verification_rate_limited":
      return label("reviews.check.rateLimited");
    case "review_verification_timeout":
      return label("reviews.check.timeout");
    case "review_verification_invalid_response":
      return label("reviews.check.invalid");
    case "review_verification_empty":
      return label("reviews.check.empty");
    case "review_verification_input_limit":
      return label("reviews.check.inputLimit");
    case "review_invalid_csv":
      return label("reviews.errors.csv");
    case "review_limit":
      return label("reviews.errors.limit");
    case "review_conflict":
      return label("reviews.errors.conflict");
    case "review_not_found":
      return label("reviews.errors.notFound");
    case "review_source_not_ready":
      return label("reviews.errors.source");
    case "review_invalid_result":
      return label("reviews.errors.result");
    case "review_channel_unavailable":
      return label("reviews.errors.channel");
    case "review_invalid_data":
      return label("reviews.errors.data");
    default:
      return label("reviews.errors.unavailable");
  }
}
const id = encodeURIComponent;
export const reviewApi = {
  list: () => request<{ workspaces: ReviewWorkspaceSummary[] }>(""),
  get: (workspaceId: string) => request<{ workspace: ReviewWorkspace }>(`/${id(workspaceId)}`),
  create: (input: CreateReviewWorkspaceInput) =>
    request<{ workspace: ReviewWorkspace }>("", "POST", input),
  delete: (workspaceId: string, expectedRevision: number) =>
    request<{ success: boolean }>(`/${id(workspaceId)}`, "DELETE", { expectedRevision }),
  annotate: (
    workspaceId: string,
    rowId: string,
    expectedRevision: number,
    annotation: Omit<ReviewAnnotation, "source" | "runId">,
  ) =>
    request<{ workspace: ReviewWorkspace }>(`/${id(workspaceId)}/rows/${id(rowId)}`, "PATCH", {
      expectedRevision,
      annotation,
    }),
  verifyNote: (workspaceId: string, rowId: string, expectedRevision: number, requestId: string) =>
    request<ReviewNoteVerificationResult>(
      `/${id(workspaceId)}/rows/${id(rowId)}/verify-note`,
      "POST",
      { expectedRevision, requestId },
    ),
  classify: (workspaceId: string, expectedRevision: number, requestId: string, rowIds: string[]) =>
    request<{ workspace: ReviewWorkspace; run: import("shared/types").ReviewRun }>(
      `/${id(workspaceId)}/jev-runs`,
      "POST",
      { expectedRevision, requestId, rowIds },
    ),
  prepare: (workspaceId: string, input: PrepareReviewRunInput) =>
    request<PreparedReviewRun>(`/${id(workspaceId)}/runs`, "POST", input),
  sync: (workspaceId: string, runId: string, expectedRevision: number) =>
    request<{ workspace: ReviewWorkspace }>(
      `/${id(workspaceId)}/runs/${id(runId)}/import`,
      "POST",
      { expectedRevision },
    ),
};
