import type {
  AgentPlanStepStatus,
  AgentTaskAttachment,
  AgentTaskComplexity,
} from "./agentTaskService";

export interface AgentPlanBuilderInput {
  goal: string;
  complexity?: AgentTaskComplexity | null;
  attachments?: AgentTaskAttachment[] | null;
}

export interface AgentPlanBuilderStep {
  title: string;
  description: string;
  status: AgentPlanStepStatus;
}

function normalizeGoal(goal: string) {
  return goal.trim().replace(/\s+/g, " ");
}

function shortenGoal(goal: string, limit = 72) {
  return goal.length > limit ? `${goal.slice(0, limit - 3).trim()}...` : goal;
}

function hasKeyword(goal: string, pattern: RegExp) {
  return pattern.test(goal);
}

function hasCurrentExternalSignal(goal: string) {
  return hasKeyword(
    goal,
    /(\bcurrent\s+(?:news|events?|status|state|pricing|price|market|weather|version|versions|api|docs?|documentation|information|info|date|time|conditions?|situation|affairs)\b|当前(?:价格|汇率|股价|行情|版本|天气|新闻|局势|政策|情况|信息|日期|时间))/i,
  );
}

function detectSignals(goal: string, attachments: AgentTaskAttachment[]) {
  const normalized = goal.toLowerCase();
  const hasAttachments = attachments.length > 0;
  const mentionsFiles = hasKeyword(
    normalized,
    /(attachment|attachments|file|files|pdf|doc|docs|document|documents|image|images|screenshot|log|logs|附件|文件|文档|材料|图片|截图|日志)/i,
  );
  const research = hasKeyword(
    normalized,
    /(\b(?:research|investigate|lookup|search|survey|compare|benchmark|analy[sz]e|audit|cite|sources)\b|look up|调研|研究|搜索|联网|对比|检索|资料|来源)/i,
  );
  const code = hasKeyword(
    normalized,
    /(\b(?:code|repo|repository|workspace|readme|package\.json|tsconfig(?:\.json)?|app|server|desktop|web|bug|fix|implement|refactor|debug|trace|test|tests|build|compile|stack)\b|开发|代码|仓库|工作区|修复|实现|调试|排查|测试|构建)/i,
  );
  const writing = hasKeyword(
    normalized,
    /(\b(?:write|draft|article|report|proposal|doc|documentation|spec|summary|summari[sz]e|blog|slide|slides|presentation)\b|写|文案|草稿|报告|提案|说明|总结|方案|稿件)/i,
  );
  const latest = hasKeyword(
    normalized,
    /(\blatest\b|\brecent\b|\btoday\b|\bnews\b|\bnow\b|up-to-date|实时|最新|今天|最近)/i,
  );

  return {
    hasAttachments,
    mentionsFiles,
    research,
    code,
    writing,
    latest: latest || hasCurrentExternalSignal(normalized),
  };
}

function createStep(
  title: string,
  description: string,
  status: AgentPlanStepStatus = "pending",
): AgentPlanBuilderStep {
  return {
    title,
    description,
    status,
  };
}

export function buildAgentPlan(input: AgentPlanBuilderInput): AgentPlanBuilderStep[] {
  const goal = normalizeGoal(input.goal);
  const complexity = input.complexity ?? "standard";
  const attachments = (input.attachments ?? []).filter(Boolean);
  const executionTitle = shortenGoal(goal || "Execute the requested task");
  const signals = detectSignals(goal, attachments);

  const steps: AgentPlanBuilderStep[] = [
    createStep(
      signals.hasAttachments || signals.mentionsFiles
        ? "Align on the goal and available materials"
        : "Align on the goal and constraints",
      signals.hasAttachments || signals.mentionsFiles
        ? "Review the task goal, attachments, and any explicit constraints before moving into execution."
        : "Clarify the requested outcome, scope boundaries, and any obvious constraints before execution.",
      "ready",
    ),
  ];

  if (signals.hasAttachments || signals.mentionsFiles) {
    steps.push(
      createStep(
        "Read attachments and extract relevant context",
        "Inspect the provided files or materials, pull out the information that matters, and keep only the context needed for the task.",
      ),
    );
  }

  if (signals.code && signals.research) {
    steps.push(
      createStep(
        "Inspect the workspace and collect supporting references",
        "Review the affected code paths or workspace context, and gather any external references needed to complete the task safely.",
      ),
    );
  } else if (signals.code) {
    steps.push(
      createStep(
        "Inspect the workspace and affected code paths",
        "Check the relevant files, dependencies, and constraints in the current workspace before making changes.",
      ),
    );
  } else if (signals.research || signals.latest) {
    steps.push(
      createStep(
        signals.latest
          ? "Collect current external information"
          : "Gather supporting information and evidence",
        signals.latest
          ? "Use the appropriate external sources to gather up-to-date facts, then narrow to the evidence most relevant to the task."
          : "Gather the context, references, and supporting evidence needed to answer the task confidently.",
      ),
    );
  }

  steps.push(
    createStep(
      executionTitle,
      signals.code
        ? "Carry out the code or workspace work for the task, keeping the implementation focused on the approved goal."
        : signals.writing
          ? "Draft the requested deliverable in a form that is already close to the final output."
          : signals.research
            ? "Synthesize the collected information into the core task result."
            : "Carry out the core task and produce the main working result.",
    ),
  );

  const needsVerification =
    complexity !== "light" || signals.hasAttachments || signals.research || signals.code;

  if (needsVerification) {
    steps.push(
      createStep(
        signals.code
          ? "Validate changes and check risks"
          : signals.research
            ? "Verify evidence and resolve gaps"
            : signals.writing
              ? "Review quality and consistency"
              : "Verify outcome and note remaining risks",
        signals.code
          ? "Run or inspect the most relevant checks, confirm the change is coherent, and capture any known risk or follow-up."
          : signals.research
            ? "Check that the answer is backed by the gathered evidence and close any obvious gaps before final delivery."
            : signals.writing
              ? "Review the draft for structure, clarity, and consistency before handing it off."
              : "Confirm the result meets the request, then capture open risks or limitations before delivery.",
      ),
    );
  }

  if (steps.length < 3 || complexity === "deep" || signals.code || signals.research || signals.writing) {
    steps.push(
      createStep(
        signals.code
          ? "Package the final change summary"
          : signals.research
            ? "Package conclusions and source-backed answer"
            : signals.writing
              ? "Polish and deliver the final draft"
              : "Summarize the final outcome",
        signals.code
          ? "Summarize what changed, the current outcome, and the most important caveats for the user."
          : signals.research
            ? "Turn the verified findings into a concise answer with the key supporting evidence."
            : signals.writing
              ? "Refine the wording and structure so the final draft is ready to present."
              : "Package the final result so the user can quickly understand the outcome and the next step.",
      ),
    );
  }

  const limited = steps.slice(0, 6);
  if (limited.length < 3) {
    limited.push(
      createStep(
        "Summarize the final outcome",
        "Package the final result so the user can quickly understand what happened and what to do next.",
      ),
    );
  }

  if (limited.length > 6) {
    return limited.slice(0, 6);
  }

  return limited;
}
