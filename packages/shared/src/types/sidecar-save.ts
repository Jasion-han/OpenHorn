/** Optimistic save preconditions are captured before an Agent edit changes its rows. */
export interface SidecarSavePreconditions {
  expectedUserToken?: string | null;
  expectedAssistantToken?: string | null;
  /** Restart recovery must never silently fall back to unguarded legacy writes. */
  recovery?: boolean;
}
export interface SidecarSaveResult {
  userMessageId: string;
  assistantMessageId: string;
  replayed?: boolean;
  saveTokens?: { user: string; assistant: string };
}
