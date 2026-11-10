export type UnifiedSearchKind =
  | "conversation"
  | "message"
  | "artifact"
  | "recipe"
  | "project"
  | "reviews"
  | "library";
export interface UnifiedSearchResult {
  kind: UnifiedSearchKind;
  id: string;
  title: string;
  snippet: string;
  conversationId?: string;
}
