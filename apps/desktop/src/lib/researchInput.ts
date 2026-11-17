import type { researchInputIssue } from "shared/research";
import { getChatLabel } from "./i18n/agent";

export const researchInputMessage = (issue: ReturnType<typeof researchInputIssue>) =>
  issue
    ? getChatLabel(
        issue === "research_question_required" ? "chat.research.question" : `chat.${issue}`,
      )
    : null;
