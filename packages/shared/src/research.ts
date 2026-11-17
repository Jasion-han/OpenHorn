export const RESEARCH_LIMITS = Object.freeze({
  searches: 4,
  pages: 6,
  rounds: 12,
  milliseconds: 180_000,
});
export const RESEARCH_ERRORS = [
  "research_unavailable",
  "research_network_required",
  "research_no_sources",
  "research_timeout",
  "research_model_timeout",
  "research_invalid_sources",
  "research_output_limit",
  "research_report_empty",
  "research_failed",
  "research_attachments_unsupported",
] as const;
export type ResearchErrorCode = (typeof RESEARCH_ERRORS)[number];
export const isResearchErrorCode = (value: unknown): value is ResearchErrorCode =>
  RESEARCH_ERRORS.some((code) => code === value);
export const isResearchProtocol = (protocol?: string) =>
  protocol === "openai" || protocol === "anthropic" || protocol === "google";
export const researchQuestion = (text: string): string | null => {
  const match = text.match(/^\s*\/research(?:\s+([\s\S]*))?$/i);
  return match ? (match[1] ?? "").trim() : null;
};
export const withResearchCommand = (text: string) =>
  researchQuestion(text) === null ? `/research ${text}` : text;
export const withoutResearchCommand = (text: string) => researchQuestion(text) ?? text;

export function researchInputIssue(input: {
  text: string;
  enabled?: boolean;
  protocol?: string;
  webSearchEnabled: boolean;
  hasAttachments: boolean;
  runtimeAvailable: boolean;
}): "research_question_required" | ResearchErrorCode | null {
  const command = researchQuestion(input.text);
  if (!input.enabled && command === null) return null;
  if (!(command ?? input.text).trim()) return "research_question_required";
  if (!input.webSearchEnabled) return "research_network_required";
  if (input.hasAttachments) return "research_attachments_unsupported";
  if (!input.runtimeAvailable || !isResearchProtocol(input.protocol)) return "research_unavailable";
  return null;
}
