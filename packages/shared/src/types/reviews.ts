export type ReviewDelimiter = "," | ";" | "\t";
export type ReviewSentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown";
export interface ReviewResult {
  id: string;
  sentiment: ReviewSentiment;
  topics: string[];
  quote: string;
  note: string;
}
export interface ReviewAnnotation extends Omit<ReviewResult, "id"> {
  source: "ai" | "manual";
  runId: string | null;
}
export interface ReviewRecord {
  id: string;
  sourceRow: number;
  text: string;
  rating: string;
  annotation: ReviewAnnotation | null;
  annotationRevision: number;
  noteVerification?: ReviewNoteVerification;
}
export type ReviewNoteVerdict = "supported" | "review" | "uncertain" | "not_applicable";
export interface ReviewNoteQuestion {
  type: "noul";
  instructions: Record<string, string>;
  criteria: { true: string; false: string };
}
export interface ReviewNoteRequest {
  model: string;
  state: { review: { text: string }; annotation: { note: string } };
  questions: Record<string, ReviewNoteQuestion>;
}
export interface ReviewNoteVerification {
  requestId: string;
  annotationRevision: number;
  questionVersion: string;
  model: string;
  checkedAt: string;
  probability: number;
  hasClaimsProbability?: number;
  verdict: ReviewNoteVerdict;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}
export interface ReviewNoteVerificationResult {
  workspace: ReviewWorkspace;
  verification: ReviewNoteVerification;
  request: ReviewNoteRequest;
  cached: boolean;
}
export interface ReviewSource {
  csv: string;
  fileName: string;
  delimiter: ReviewDelimiter;
  textColumn: number;
  ratingColumn: number | null;
}
export interface ReviewRun {
  engine?: "jev";
  decision?: import("./decisions").ReviewDecisionMetadata;
  id: string;
  requestId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  importedAt: string | null;
  instructions: string;
  inputs: Array<{ id: string; text: string; rating: string; revision: number }>;
  results: ReviewResult[] | null;
  applied: number;
  skipped: number;
}
export interface ReviewData {
  schemaVersion: 1;
  source: ReviewSource;
  skippedRows: number;
  rows: ReviewRecord[];
  runs: ReviewRun[];
}
export interface ReviewWorkspaceSummary {
  id: string;
  title: string;
  revision: number;
  rowCount: number;
  annotatedCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ReviewWorkspace extends ReviewWorkspaceSummary {
  data: ReviewData;
}
export interface CreateReviewWorkspaceInput extends ReviewSource {
  title: string;
}
export interface PrepareReviewRunInput {
  expectedRevision: number;
  requestId: string;
  rowIds: string[];
  channelId: string;
  modelId: string;
  instructions: string;
}
export interface PreparedReviewRun {
  workspace: ReviewWorkspace;
  run: ReviewRun;
  prompt: string;
}
