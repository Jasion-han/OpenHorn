import {
  duplicateDecisionRequest,
  relevanceDecisionRequest,
  routeDecisionRequest,
  skillDecisionRequest,
} from "shared/decision-questions";
import {
  choiceValue,
  JEV_MAX_REQUEST_BYTES,
  JEV_QUESTION_VERSION,
  noulValue,
  probabilityVerdict,
} from "shared/decisions";
import type { JevFeature } from "shared/types";
import { evaluateDecision } from "./decisionClient";

type Evaluate = typeof evaluateDecision;
export function createDecisionEnhancements(evaluate: Evaluate) {
  return {
    async filterSuggestions(
      userId: string,
      items: string[],
      titles: string[],
    ): Promise<string[] | null> {
      if (!items.length || !titles.length) return items;
      const result = await evaluate(
        userId,
        "suggestions",
        duplicateDecisionRequest(items, titles.slice(0, 5)),
      );
      if (result.ok === false) return null;
      // Only a clear duplicate is removed; uncertainty cannot erase a suggestion.
      return items.filter(
        (_, index) =>
          probabilityVerdict(noulValue(result.evaluation.answers, `s${index}`)) !== "yes",
      );
    },
    async rerank<T>(
      userId: string,
      query: string,
      items: T[],
      text: (item: T) => string,
    ): Promise<T[]> {
      if (items.length < 2 || items.length > 20) return items;
      const result = await evaluate(
        userId,
        "rerank",
        relevanceDecisionRequest(
          query,
          items.map((item) => ({ text: text(item) })),
        ),
      );
      if (result.ok === false) return items;
      // Never drop records or invent source content; ties retain the current trusted order.
      return items
        .map((item, index) => {
          const answer = result.evaluation.answers[`c${index}`];
          const score =
            0.65 * (answer.type === "score" ? answer.score / 3 : 0) + 0.35 / (index + 1);
          return { item, index, score };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ item }) => item);
    },
    async suggestSkill(
      userId: string,
      prompt: string,
      skills: Array<{ name: string; description: string }>,
    ): Promise<{ preferredNames: string[]; reason?: string }> {
      if (!skills.length) return { preferredNames: [] };
      const candidates = [...skills];
      // State and Choice criteria both carry descriptors; fit actual UTF-8 bytes,
      // keeping the desktop's full roster independent of this advisory shortlist.
      while (
        candidates.length > 2 &&
        Buffer.byteLength(JSON.stringify(skillDecisionRequest(prompt, candidates)), "utf8") >
          JEV_MAX_REQUEST_BYTES
      )
        candidates.pop();
      const result = await evaluate(userId, "skills", skillDecisionRequest(prompt, candidates));
      if (result.ok === false) return { preferredNames: [], reason: result.reason };
      if (probabilityVerdict(noulValue(result.evaluation.answers, "applicable")) !== "yes")
        return { preferredNames: [] };
      const answer = choiceValue(result.evaluation.answers, "skill");
      if (answer.probabilities[answer.choice] < 0.7) return { preferredNames: [] };
      const selected = skills.find((skill) => skill.name === answer.choice);
      return { preferredNames: selected ? [selected.name] : [] };
    },
  };
}
export const decisionEnhancements = createDecisionEnhancements(evaluateDecision);
const shadow = new Map<string, { compared: number; disagreements: number; unavailable: number }>();
export function routeShadowStats(userId: string) {
  return shadow.get(userId) ?? { compared: 0, disagreements: 0, unavailable: 0 };
}
export async function observeRouteDecision(
  userId: string,
  prompt: string,
  actualRoute: string,
): Promise<void> {
  const result = await evaluateDecision(
    userId,
    "routeShadow" satisfies JevFeature,
    routeDecisionRequest(prompt),
  );
  if (result.ok === false && result.reason === "disabled") return;
  while (shadow.size >= 256 && !shadow.has(userId))
    shadow.delete(shadow.keys().next().value as string);
  const current = routeShadowStats(userId);
  if (result.ok === false) shadow.set(userId, { ...current, unavailable: current.unavailable + 1 });
  else {
    const answer = choiceValue(result.evaluation.answers, "route");
    shadow.set(userId, {
      ...current,
      compared: current.compared + 1,
      disagreements: current.disagreements + Number(answer.choice !== actualRoute),
    });
  }
}
export const decisionQuestionVersion = JEV_QUESTION_VERSION;
