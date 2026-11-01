import { BuiltinActionType } from "@openuidev/lang-core";

/**
 * Match the evaluated action shapes consumed by OpenUI's triggerAction.
 * Only the action determines whether clicking can prepare a follow-up; labels
 * cannot tell us whether the program implements the operation they describe.
 */
export function offersFollowUp(action: unknown): boolean {
  // Button passes no plan for a falsey action, which offers its label instead.
  if (!action) return true;
  if (typeof action !== "object") return false;

  if ("steps" in action) {
    // A falsey steps field falls through to the upstream implicit follow-up.
    if (!action.steps) return true;
    return (
      Array.isArray(action.steps) &&
      action.steps.some(
        (step: unknown) =>
          step !== null &&
          typeof step === "object" &&
          "type" in step &&
          step.type === BuiltinActionType.ContinueConversation,
      )
    );
  }

  // Legacy actions default a missing/empty type to ContinueConversation.
  return (
    !("type" in action) || !action.type || action.type === BuiltinActionType.ContinueConversation
  );
}
