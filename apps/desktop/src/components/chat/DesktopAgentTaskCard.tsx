import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  FileText,
  Loader2,
  PackageOpen,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, cn } from "ui";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "../../lib/agentTaskStream";
import { sanitizeDisplayContent } from "../../lib/citations";
import { notifyError, notifySuccess } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentPlanStep,
  ApiAgentRun,
  ApiAgentTaskDetail,
  ApiAgentTaskEvent,
  ApiAgentTaskUxMode,
  ApiCitation,
} from "../../types/chat";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";

const api = createServerApi();

const TASK_STATUS_LABELS = {
  draft: "草稿",
  planning: "规划中",
  awaiting_approval: "待审批",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
} satisfies Record<NonNullable<ApiAgentRun["taskStatus"]>, string>;

type TimelineStepStatus = "done" | "active" | "pending" | "error";

type TimelineStep = {
  id: string;
  label: string;
  description: string;
  status: TimelineStepStatus;
};

type ToolApprovalPayload = {
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  blockedPath?: string | null;
  decisionReason?: string | null;
};

function extractErrorMessage(error: unknown, fallback = "任务执行失败") {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getArtifactCitations(artifact: ApiAgentArtifact | null | undefined): ApiCitation[] | undefined {
  if (!artifact || !isRecord(artifact.metadata)) return undefined;
  const citations = artifact.metadata.citations;
  return Array.isArray(citations) ? (citations as ApiCitation[]) : undefined;
}

function getTaskFinalResultArtifact(detail: ApiAgentTaskDetail) {
  return detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
}

function getTaskFinalResultCitations(detail: ApiAgentTaskDetail) {
  return getArtifactCitations(getTaskFinalResultArtifact(detail));
}

function TaskMetaPill({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px]",
        tone === "accent"
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
          : tone === "danger"
            ? "border-destructive/20 bg-destructive/5 text-destructive"
            : "border-border/60 bg-background/70 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function ProcessSection({
  title,
  meta,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  meta?: string | null;
  icon: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="overflow-hidden rounded-xl border border-border/45 bg-background/55">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-background/60"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground/85">
            {icon}
            <span>{title}</span>
          </div>
          {meta ? <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{meta}</p> : null}
        </div>
        <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>{open ? "收起" : "展开"}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </div>
      </button>
      {open ? <div className="border-t border-border/40 px-3 py-2.5">{children}</div> : null}
    </section>
  );
}

function StepIcon({ status }: { status: ApiAgentPlanStep["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === "running") return <Clock3 className="h-4 w-4 text-blue-600" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function getToolApprovalPayload(payload: unknown): ToolApprovalPayload | null {
  if (!isRecord(payload)) return null;
  return {
    toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : undefined,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    toolInput: isRecord(payload.toolInput) ? payload.toolInput : undefined,
    blockedPath: typeof payload.blockedPath === "string" ? payload.blockedPath : null,
    decisionReason: typeof payload.decisionReason === "string" ? payload.decisionReason : null,
  };
}

function summarizeApprovalToolInput(toolInput: Record<string, unknown> | undefined) {
  if (!toolInput) return null;

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return toolInput.command.trim();
  }

  const preferredKeys = ["file_path", "path", "pattern", "query", "url"];
  const lines = preferredKeys
    .map((key) => {
      const value = toolInput[key];
      if (typeof value !== "string" || !value.trim()) return null;
      return `${key}: ${value.trim()}`;
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length > 0) return lines.join("\n");

  try {
    return JSON.stringify(toolInput, null, 2);
  } catch {
    return null;
  }
}

function DesktopApprovalBlock({
  approval,
  onApprove,
  onReject,
}: {
  approval: ApiAgentApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isPending = approval.status === "pending";
  const approveLabel = approval.type === "tool_approval" ? "批准继续" : "批准执行";
  const rejectLabel = approval.type === "tool_approval" ? "拒绝本次工具调用" : "拒绝并返回草稿";
  const toolPayload =
    approval.type === "tool_approval" ? getToolApprovalPayload(approval.payload) : null;
  const toolSummary = summarizeApprovalToolInput(toolPayload?.toolInput);
  const statusToneClassName =
    approval.status === "approved"
      ? "border-emerald-200/70 bg-emerald-50/50"
      : approval.status === "rejected"
        ? "border-destructive/20 bg-destructive/5"
        : "border-orange-200/70 bg-orange-50/45";

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${statusToneClassName}`}>
      <div className="flex items-start gap-3">
        {approval.status === "approved" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
        ) : approval.status === "rejected" ? (
          <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 text-orange-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{approval.title}</div>
          {approval.description ? (
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {approval.description}
            </p>
          ) : null}
          <div className="mt-2 inline-flex rounded-full border border-border/40 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            {approval.status === "pending"
              ? "等待处理"
              : approval.status === "approved"
                ? "已批准"
                : "已拒绝"}
          </div>
        </div>
      </div>

      {toolPayload ? (
        <div className="mt-3 space-y-2">
          {toolPayload.toolName ? (
            <div className="rounded-lg border border-border/45 bg-background/75 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">工具</div>
              <div className="mt-0.5 text-[12px] font-medium">{toolPayload.toolName}</div>
            </div>
          ) : null}

          {toolPayload.decisionReason ? (
            <div className="rounded-lg border border-orange-500/15 bg-orange-500/5 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">原因</div>
              <p className="mt-0.5 text-[12px] leading-5 text-foreground/90">
                {toolPayload.decisionReason}
              </p>
            </div>
          ) : null}

          {toolPayload.blockedPath ? (
            <div className="rounded-lg border border-border/45 bg-background/75 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">受限路径</div>
              <p className="mt-0.5 break-all font-mono text-[11px] text-foreground/90">
                {toolPayload.blockedPath}
              </p>
            </div>
          ) : null}

          {toolSummary ? (
            <div className="rounded-lg border border-border/45 bg-background/75 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">待处理内容</div>
              <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/90">
                {toolSummary}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {isPending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={onApprove}>
            {approveLabel}
          </Button>
          <Button size="sm" variant="outline" onClick={onReject}>
            {rejectLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DesktopPlanPanel({
  planSteps,
  approval,
  onApprove,
  onReject,
}: {
  planSteps: ApiAgentPlanStep[];
  approval: ApiAgentApproval | null;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  return (
    <section className="space-y-3">
      {planSteps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 px-3 py-2.5 text-sm text-muted-foreground">
          当前运行没有关联的计划步骤。
        </div>
      ) : (
        <div className="space-y-2">
          {planSteps.map((step) => (
            <div
              key={step.id}
              className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5"
            >
              <div className="flex gap-3">
                <div className="pt-0.5">
                  <StepIcon status={step.status} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {step.orderIndex + 1}. {step.title}
                  </div>
                  {step.description ? (
                    <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                      {step.description}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {approval ? (
        <div className="mt-4">
          <DesktopApprovalBlock
            approval={approval}
            onApprove={() => onApprove(approval.id)}
            onReject={() => onReject(approval.id)}
          />
        </div>
      ) : null}
    </section>
  );
}

function getExecutionEventType(event: ApiAgentTaskEvent) {
  return isRecord(event.metadata) ? event.metadata.eventType : null;
}

function humanizeToolName(toolName: string | null | undefined) {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (!normalized) return "工具";
  if (normalized === "bash") return "命令执行";
  if (normalized.includes("browser")) return "网页操作";
  if (normalized.includes("search")) return "网络搜索";
  if (normalized.includes("fetch")) return "网页抓取";
  if (normalized.includes("read")) return "读取内容";
  if (normalized.includes("write") || normalized.includes("edit")) return "修改内容";
  return toolName ?? "工具";
}

function summarizeToolInput(toolInput: ApiAgentTaskEvent["toolInput"]) {
  if (!toolInput || typeof toolInput !== "object") return null;

  const input = toolInput as Record<string, unknown>;
  const query =
    typeof input.query === "string"
      ? input.query
      : typeof input.q === "string"
        ? input.q
        : typeof input.search_query === "string"
          ? input.search_query
          : null;
  if (query) {
    return `“${query.slice(0, 48)}${query.length > 48 ? "..." : ""}”`;
  }

  const url = typeof input.url === "string" ? input.url : null;
  if (url) {
    return url.length > 72 ? `${url.slice(0, 69)}...` : url;
  }

  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : null;
  if (path) return path;

  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : null;
  if (command) {
    return command.length > 72 ? `${command.slice(0, 69)}...` : command;
  }

  return null;
}

function summarizeEventContent(content: string | null | undefined) {
  const normalized = (content ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function eventLabel(event: ApiAgentTaskEvent) {
  if (event.type === "error") return "错误";
  const eventType = getExecutionEventType(event);
  if (eventType === "tool_start") return "工具启动";
  if (eventType === "tool_result") return "工具结果";
  return "执行更新";
}

function DesktopExecutionPanel({
  events,
  streamError,
}: {
  events: ApiAgentTaskEvent[];
  streamError: string | null;
}) {
  const visibleEvents = events.filter(
    (event) => event.type === "execution_event" || event.type === "error",
  );
  const displayedEvents = visibleEvents.slice(-6);
  const hiddenEventCount = visibleEvents.length - displayedEvents.length;

  return (
    <section className="space-y-3">
      {streamError ? (
        <div className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          {streamError}
        </div>
      ) : null}

      {displayedEvents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 px-3 py-2.5 text-sm text-muted-foreground">
          当前运行还没有执行日志。
        </div>
      ) : (
        <div className="space-y-2">
          {hiddenEventCount > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              仅展示最近 {displayedEvents.length} 条执行更新。
            </p>
          ) : null}

          {displayedEvents.map((event) => {
            const eventType = getExecutionEventType(event);
            const isToolEvent = eventType === "tool_start" || eventType === "tool_result";
            const toolTitle = isToolEvent ? humanizeToolName(event.toolName) : null;
            const inputSummary = isToolEvent ? summarizeToolInput(event.toolInput) : null;
            const contentSummary = summarizeEventContent(event.content);
            const semanticSummary =
              event.type === "error"
                ? contentSummary
                : eventType === "tool_start"
                  ? inputSummary
                    ? `正在处理 ${inputSummary}`
                    : "已开始执行。"
                  : eventType === "tool_result"
                    ? contentSummary || "已返回结果。"
                    : contentSummary;

            return (
              <div
                key={event.id}
                className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {event.type === "error" ? (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                  ) : isToolEvent ? (
                    <Wrench className="h-3.5 w-3.5" />
                  ) : (
                    <Bot className="h-3.5 w-3.5" />
                  )}
                  <span>{eventLabel(event)}</span>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
                {toolTitle ? <div className="mb-1 text-[13px] font-medium">{toolTitle}</div> : null}
                {semanticSummary ? (
                  <p className="text-[12px] leading-5 text-foreground/90">{semanticSummary}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function compactText(text: string, limit: number) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function summarizeArtifactLabel(artifact: ApiAgentArtifact) {
  const typeLabel =
    artifact.type === "execution_summary"
      ? "摘要"
      : artifact.type === "final_result"
        ? "结果"
        : artifact.type === "structured_result"
          ? "结构化结果"
          : artifact.type === "source_bundle"
            ? "来源集合"
            : "产物";
  return `${typeLabel} · ${artifact.title}`;
}

function DesktopArtifactsPanel({ artifacts }: { artifacts: ApiAgentArtifact[] }) {
  const finalResult = artifacts.find((artifact) => artifact.type === "final_result") ?? null;
  const summaryArtifact =
    finalResult ?? artifacts.find((artifact) => artifact.type === "execution_summary") ?? null;
  const nonSummaryArtifacts = artifacts.filter(
    (artifact) => artifact.type !== "final_result" && artifact.type !== "execution_summary",
  );
  const finalResultCitations = getArtifactCitations(finalResult);
  const finalResultDisplay = finalResult
    ? sanitizeDisplayContent(finalResult.content, finalResultCitations)
    : "";
  const summaryCitations =
    summaryArtifact?.type === "final_result" ? getArtifactCitations(summaryArtifact) : undefined;
  const summaryDisplay = summaryArtifact
    ? sanitizeDisplayContent(summaryArtifact.content, summaryCitations)
    : "";

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-foreground/85">
          <FileText className="h-4 w-4" />
          结果
        </div>
        {summaryArtifact ? (
          summaryArtifact.type === "final_result" ? (
            <div className="space-y-2.5">
              <div className="min-w-0 text-[12px] leading-5 text-foreground/90">
                <DesktopMarkdownMessage content={summaryDisplay} />
              </div>
              <DesktopCitationList citations={summaryCitations} content={summaryDisplay} />
            </div>
          ) : (
            <p className="text-[12px] leading-5 text-foreground/90">
              {compactText(summaryDisplay, 180)}
            </p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">当前运行还没有可展示的摘要。</p>
        )}
      </section>

      {nonSummaryArtifacts.length > 0 ? (
        <section className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-foreground/85">
            <PackageOpen className="h-4 w-4" />
            产物
          </div>
          <div className="space-y-2">
            {nonSummaryArtifacts.slice(0, 4).map((artifact) => (
              <div
                key={artifact.id}
                className="rounded-lg border border-border/40 bg-background/75 px-3 py-2"
              >
                <div className="text-[11px] text-muted-foreground">
                  {summarizeArtifactLabel(artifact)}
                </div>
                <p className="mt-0.5 text-[12px] leading-5 text-foreground/90">
                  {compactText(artifact.content, 100)}
                </p>
              </div>
            ))}
            {nonSummaryArtifacts.length > 4 ? (
              <p className="text-[11px] text-muted-foreground">
                其余 {nonSummaryArtifacts.length - 4} 项产物已折叠到完整结果页。
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function buildTaskStatusSummary(
  status: ApiAgentTaskDetail["task"]["status"],
  uxMode: ApiAgentTaskUxMode,
) {
  if (uxMode === "direct") {
    switch (status) {
      case "planning":
        return "正在准备后直接处理这项任务。";
      case "running":
        return "正在直接处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我先直接处理这项任务。";
    }
  }

  if (uxMode === "compact") {
    switch (status) {
      case "planning":
        return "正在整理简要步骤并开始执行。";
      case "running":
        return "正在按简要步骤处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试或查看过程。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我会按简要步骤直接开始处理。";
    }
  }

  switch (status) {
    case "planning":
      return "正在整理执行路径并开始执行。";
    case "awaiting_approval":
      return "任务暂时停下，等待进一步批准。";
    case "running":
      return "任务正在执行。";
    case "completed":
      return "任务已完成。";
    case "failed":
      return "任务执行失败，可继续、重试或重新规划。";
    case "cancelled":
      return "任务已取消。";
    default:
      return "我会先展开任务并开始执行。";
  }
}

function buildTaskMessageSummary(detail: ApiAgentTaskDetail) {
  const finalResultCitations = getTaskFinalResultCitations(detail);
  const finalResult = sanitizeDisplayContent(
    getTaskFinalResultArtifact(detail)?.content ?? "",
    finalResultCitations,
  ).trim();
  const statusSummary = buildTaskStatusSummary(detail.task.status, detail.task.uxMode);
  if (detail.task.status === "completed" && finalResult) return finalResult;

  const preview = sanitizeDisplayContent(
    detail.task.insight?.previewText ?? "",
    finalResultCitations,
  ).trim();
  const completedSummary = sanitizeDisplayContent(
    detail.task.insight?.summary ?? "",
    finalResultCitations,
  ).trim();

  if (detail.task.status === "completed") {
    return preview || completedSummary || statusSummary;
  }

  return preview || statusSummary;
}

function buildTaskBackedAgentRun(detail: ApiAgentTaskDetail): ApiAgentRun {
  const latestRun = detail.runs[0] ?? null;
  const latestApproval = detail.approvals[0] ?? null;

  return {
    status:
      detail.task.status === "awaiting_approval"
        ? "awaiting_approval"
        : detail.task.status === "running"
          ? "running"
          : detail.task.status === "failed"
            ? "failed"
            : detail.task.status === "cancelled"
              ? "cancelled"
              : "completed",
    summary: buildTaskMessageSummary(detail),
    steps: [],
    taskId: detail.task.id,
    complexity: detail.task.complexity,
    uxMode: detail.task.uxMode,
    requiresPlanApproval: detail.task.requiresPlanApproval,
    autoStart: detail.task.autoStart,
    taskStatus: detail.task.status,
    latestRunId: latestRun?.id ?? null,
    latestRunPhase: latestRun?.phase ?? null,
    latestApprovalId: latestApproval?.id ?? null,
    latestApprovalType: latestApproval?.type ?? null,
    latestApprovalStatus: latestApproval?.status ?? null,
  };
}

function getPendingApproval(detail: ApiAgentTaskDetail): ApiAgentApproval | null {
  return detail.approvals.find((approval) => approval.status === "pending") ?? null;
}

function getPlanStepsForDetail(detail: ApiAgentTaskDetail, approval: ApiAgentApproval | null) {
  const planningRunId =
    approval?.type === "plan_approval"
      ? approval.runId
      : (detail.runs.find((run) => run.phase === "planning")?.id ?? null);

  if (!planningRunId) return [];
  return detail.planSteps
    .filter((step) => step.runId === planningRunId)
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

function getLatestExecutionRun(detail: ApiAgentTaskDetail) {
  return detail.runs.find((run) => run.phase === "execution") ?? null;
}

function getRunEvents(detail: ApiAgentTaskDetail, runId: string | null): ApiAgentTaskEvent[] {
  if (!runId) return [];
  return detail.events.filter((event) => event.runId === runId);
}

function getRunArtifacts(detail: ApiAgentTaskDetail, runId: string | null): ApiAgentArtifact[] {
  if (!runId) return [];
  return detail.artifacts.filter((artifact) => artifact.runId === runId);
}

function getToolActionKind(toolName: string | null | undefined) {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (!normalized) return "generic";
  if (normalized === "bash") return "command";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("fetch")) return "fetch";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "write";
  return "generic";
}

function summarizeExecutionEvent(event: ApiAgentTaskEvent) {
  const eventType = getExecutionEventType(event);
  const normalized = (event.content ?? "").trim().replace(/\s+/g, " ");
  const toolKind = getToolActionKind(event.toolName);

  if (event.type === "error") {
    return normalized || "本轮动作中断。";
  }

  if (eventType === "tool_start") {
    const inputSummary = summarizeToolInput(event.toolInput);
    if (toolKind === "search") {
      return inputSummary ? `正在搜索 ${inputSummary}` : "正在搜索相关信息。";
    }
    if (toolKind === "browser") return "正在访问目标页面。";
    if (toolKind === "fetch") return "正在抓取网页内容。";
    if (toolKind === "read") return "正在读取相关内容。";
    if (toolKind === "write") return "正在整理中间结果。";
    if (toolKind === "command") return "正在执行命令。";
    return "正在执行本轮动作。";
  }

  if (eventType === "tool_result") {
    if (toolKind === "search") return "已获取搜索结果。";
    if (toolKind === "browser") return "已访问目标页面。";
    if (toolKind === "fetch") return "已抓取网页内容。";
    if (toolKind === "read") return "已读取相关内容。";
    if (toolKind === "write") return "已整理中间结果。";
    if (toolKind === "command") return "已完成命令执行。";
    return "已完成本轮工具操作。";
  }

  if (!normalized) return null;
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

function summarizePlanStepTitle(stepTitle: string | null | undefined, taskTitle: string) {
  const normalized = (stepTitle ?? "").trim().replace(/\s+/g, " ");
  const normalizedTaskTitle = taskTitle.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized === normalizedTaskTitle) return null;
  if (normalized.includes(normalizedTaskTitle)) return null;
  return normalized.length > 32 ? `${normalized.slice(0, 29)}...` : normalized;
}

function buildTimelineSteps(params: {
  detail: ApiAgentTaskDetail;
  planSteps: ReturnType<typeof getPlanStepsForDetail>;
  visibleExecutionEvents: ApiAgentTaskEvent[];
  streamError: string | null;
}) {
  const { detail, planSteps, visibleExecutionEvents, streamError } = params;
  const status = detail.task.status;
  const latestPlanStep =
    [...planSteps]
      .reverse()
      .find((step) => step.status === "running" || step.status === "completed") ??
    planSteps[0] ??
    null;
  const latestExecutionEvent = [...visibleExecutionEvents].reverse()[0] ?? null;
  const finalResult = getTaskFinalResultArtifact(detail)?.content.trim();
  const hasExecution = visibleExecutionEvents.length > 0;
  const hasPlan = planSteps.length > 0;
  const planningFinished = status !== "planning";
  const executionFinished = status === "completed" || status === "cancelled";
  const actionDescription =
    streamError ||
    (latestExecutionEvent ? summarizeExecutionEvent(latestExecutionEvent) : null) ||
    (status === "running"
      ? "正在自主推进任务。"
      : hasExecution
        ? "已完成本轮动作。"
        : "等待进入执行阶段。");

  const steps: TimelineStep[] = [
    {
      id: "intent",
      label: "理解需求",
      description: "已确认当前目标与边界。",
      status: planningFinished ? "done" : "active",
    },
  ];

  if (hasPlan || status === "planning" || status === "awaiting_approval") {
    steps.push({
      id: "plan",
      label: "形成路径",
      description:
        summarizePlanStepTitle(latestPlanStep?.title, detail.task.title) ??
        (status === "planning" ? "正在整理最短可行路径。" : "已确定执行路径。"),
      status:
        status === "awaiting_approval"
          ? "active"
          : status === "planning"
            ? "active"
            : hasPlan
              ? "done"
              : "pending",
    });
  }

  steps.push({
    id: "action",
    label: "执行动作",
    description: actionDescription,
    status:
      status === "failed"
        ? "error"
        : status === "running"
          ? "active"
          : executionFinished
            ? "done"
            : hasExecution
              ? "done"
              : "pending",
  });

  steps.push({
    id: "answer",
    label: status === "failed" ? "等待修正" : "输出结果",
    description:
      status === "completed"
        ? finalResult
          ? "结论已整理到正文。"
          : "最终回答已生成。"
        : status === "failed"
          ? streamError || "这轮执行未能顺利完成。"
          : status === "cancelled"
            ? "本轮任务已取消。"
            : "完成动作后会在正文给出结果。",
    status:
      status === "completed"
        ? "done"
        : status === "failed"
          ? "error"
          : status === "cancelled"
            ? "done"
            : "pending",
  });

  return steps;
}

function TimelineStatusDot({ status }: { status: TimelineStepStatus }) {
  if (status === "active") {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-blue-300/70 bg-blue-50 text-blue-700 shadow-[0_0_0_3px_rgba(59,130,246,0.10)] transition-all duration-200">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  }

  if (status === "done") {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-emerald-300/70 bg-emerald-50 text-emerald-700 transition-all duration-200">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-destructive/30 bg-destructive/5 text-destructive transition-all duration-200">
        <AlertCircle className="h-3.5 w-3.5" />
      </span>
    );
  }

  return <span className="h-2.5 w-2.5 rounded-full bg-border/80 transition-all duration-200" />;
}

function TimelineStepItem({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  const cardClassName =
    step.status === "active"
      ? "border-blue-200/80 bg-blue-50/60"
      : step.status === "done"
        ? "border-emerald-200/70 bg-emerald-50/35"
        : step.status === "error"
          ? "border-destructive/20 bg-destructive/5"
          : "border-border/50 bg-background/55";

  return (
    <div className="relative flex gap-3">
      <div className="relative flex w-6 shrink-0 justify-center pt-2">
        {!isLast ? <div className="absolute top-7 bottom-[-10px] w-px bg-border/60" /> : null}
        <TimelineStatusDot status={step.status} />
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-xl border px-3 py-2.5 transition-all duration-200",
          cardClassName,
        )}
      >
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-foreground/90">{step.label}</p>
          {step.status === "active" ? (
            <span className="rounded-full border border-blue-300/60 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
              处理中
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{step.description}</p>
      </div>
    </div>
  );
}

function mergeExecutionEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
  const events = [...detail.events];
  const last = events[events.length - 1];
  const lastEventType = last && isRecord(last.metadata) ? last.metadata.eventType : null;
  const nextEventType = isRecord(nextEvent.metadata) ? nextEvent.metadata.eventType : null;

  if (
    nextEvent.type === "execution_event" &&
    nextEventType === "text" &&
    last?.type === "execution_event" &&
    lastEventType === "text"
  ) {
    events[events.length - 1] = {
      ...last,
      content: `${last.content ?? ""}${nextEvent.content ?? ""}`,
      createdAt: nextEvent.createdAt,
    };
    return { ...detail, events };
  }

  events.push(nextEvent);
  return { ...detail, events };
}

function toLiveEvent(taskId: string, event: AgentTaskStreamEvent): ApiAgentTaskEvent | null {
  if (event.type !== "execution_event" && event.type !== "error") return null;

  return {
    id: `desktop-live-${Date.now()}-${Math.random()}`,
    taskId,
    runId: event.runId ?? "live-run",
    type: event.type === "error" ? "error" : "execution_event",
    content: event.content ?? null,
    toolName: "toolName" in event ? (event.toolName ?? null) : null,
    toolInput: "toolInput" in event ? (event.toolInput ?? null) : null,
    metadata: {
      eventType: "eventType" in event ? (event.eventType ?? "text") : "error",
      live: true,
    },
    createdAt: new Date().toISOString(),
  };
}

export function DesktopAgentTaskCard({ messageId, taskId }: { messageId: string; taskId: string }) {
  const [detail, setDetail] = useState<ApiAgentTaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "approve" | "reject" | "execute" | "retry" | "continue" | "replan" | "cancel" | null
  >(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const autoExecuteKeyRef = useRef<string | null>(null);

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    useChatStore.getState().updateMessage(messageId, {
      content: buildTaskMessageSummary(nextDetail),
      agentRun: buildTaskBackedAgentRun(nextDetail),
      citations: getTaskFinalResultCitations(nextDetail),
    });
  };

  const loadDetail = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const nextDetail = await api.agentTasks.get(taskId);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      return nextDetail;
    } catch (error) {
      if (!silent) {
        notifyError("加载任务失败", error instanceof Error ? error.message : "无法加载 Agent 任务");
      }
      return null;
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDetail();
  }, [taskId]);

  useEffect(() => {
    if (
      !detail ||
      (detail.task.status !== "running" && detail.task.status !== "awaiting_approval")
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [detail?.task.status, taskId]);

  const approval = useMemo(() => (detail ? getPendingApproval(detail) : null), [detail]);
  const effectiveUxMode = useMemo<ApiAgentTaskUxMode>(() => {
    if (!detail) return "full";
    if (approval?.status === "pending") return "full";
    return detail.task.uxMode;
  }, [detail, approval]);
  const planSteps = useMemo(
    () => (detail ? getPlanStepsForDetail(detail, approval) : []),
    [detail, approval],
  );
  const executionRun = useMemo(() => (detail ? getLatestExecutionRun(detail) : null), [detail]);
  const executionEvents = useMemo(
    () => (detail ? getRunEvents(detail, executionRun?.id ?? null) : []),
    [detail, executionRun],
  );
  const visibleExecutionEvents = useMemo(
    () =>
      executionEvents.filter((event) => event.type === "execution_event" || event.type === "error"),
    [executionEvents],
  );
  const executionArtifacts = useMemo(
    () => (detail ? getRunArtifacts(detail, executionRun?.id ?? null) : []),
    [detail, executionRun],
  );
  const inlineSummary = useMemo(() => {
    if (!detail) return "";
    return buildTaskStatusSummary(detail.task.status, effectiveUxMode);
  }, [detail, effectiveUxMode]);

  useEffect(() => {
    if (!detail) return;
    if (detail.task.status === "failed" || detail.task.status === "awaiting_approval") {
      setExpanded(true);
    }
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    if (
      (effectiveUxMode === "direct" || effectiveUxMode === "compact") &&
      (detail.task.status === "completed" || detail.task.status === "cancelled")
    ) {
      setExpanded(false);
    }
  }, [detail, effectiveUxMode]);

  useEffect(() => {
    if (!detail || !detail.task.autoStart || detail.task.status !== "draft") return;
    const key = `${detail.task.id}:${detail.task.updatedAt}:${detail.task.status}`;
    if (autoExecuteKeyRef.current === key || busyAction !== null) return;
    autoExecuteKeyRef.current = key;
    void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id));
  }, [detail, busyAction]);

  const runExecutionAction = async (
    action: "execute" | "retry" | "continue",
    responseFactory: () => Promise<Response>,
  ) => {
    if (!detail) return;
    setBusyAction(action);
    if (detail.task.uxMode !== "direct") {
      setExpanded(true);
    }
    setStreamError(null);

    try {
      await streamAgentTaskExecution(
        detail.task.id,
        {
          onEvent: async (event) => {
            if (event.type === "task_status") {
              setDetail((current) =>
                current
                  ? {
                      ...current,
                      task: { ...current.task, status: event.status },
                    }
                  : current,
              );
              if (
                event.status === "awaiting_approval" ||
                event.status === "completed" ||
                event.status === "failed"
              ) {
                const refreshed = await loadDetail(true);
                if (refreshed) setDetail(refreshed);
              }
              return;
            }

            if (event.type === "plan_step") {
              setDetail((current) =>
                current
                  ? {
                      ...current,
                      planSteps: current.planSteps.map((step) =>
                        step.id === event.stepId ? { ...step, status: event.status } : step,
                      ),
                    }
                  : current,
              );
              return;
            }

            if (event.type === "final_result") {
              useChatStore.getState().updateMessage(messageId, {
                content: event.content,
                citations: event.citations,
              });
              setDetail((current) => {
                if (!current) return current;
                const artifact: ApiAgentArtifact = {
                  id: `desktop-live-final-${event.runId}`,
                  taskId: current.task.id,
                  runId: event.runId,
                  type: "final_result",
                  title: "Final result",
                  content: event.content,
                  metadata: { live: true, citations: event.citations ?? null },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                return {
                  ...current,
                  artifacts: [
                    artifact,
                    ...current.artifacts.filter((item) => item.id !== artifact.id),
                  ],
                };
              });
              return;
            }

            const liveEvent = toLiveEvent(detail.task.id, event);
            if (liveEvent) {
              setDetail((current) => (current ? mergeExecutionEvent(current, liveEvent) : current));
              return;
            }

            if (event.type === "done") {
              await loadDetail(true);
            }
          },
          onError: (message) => {
            setStreamError(extractErrorMessage(message, "任务执行失败"));
          },
        },
        {
          response: await responseFactory(),
          action,
        },
      );

      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } catch (error) {
      const message = extractErrorMessage(error, "任务执行失败");
      setStreamError(message);
      notifyError("任务执行失败", message);
      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } finally {
      setBusyAction(null);
    }
  };

  const handleApproval = async (status: "approved" | "rejected") => {
    if (!approval) return;
    setBusyAction(status === "approved" ? "approve" : "reject");
    try {
      const nextDetail = await api.agentTasks.respondApproval(approval.id, { status });
      setDetail(nextDetail);
      syncMessage(nextDetail);
      notifySuccess(status === "approved" ? "已批准" : "已拒绝", "审批状态已更新。");
    } catch (error) {
      notifyError("审批失败", error instanceof Error ? error.message : "无法更新审批状态");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReplan = async () => {
    if (!detail) return;
    setBusyAction("replan");
    try {
      const nextDetail = await api.agentTasks.plan(detail.task.id);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      setExpanded(true);
      notifySuccess("已重新规划", "任务计划已重新生成。");
    } catch (error) {
      notifyError("重新规划失败", error instanceof Error ? error.message : "无法重新规划任务");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    if (!detail) return;
    setBusyAction("cancel");
    try {
      const nextDetail = await api.agentTasks.cancel(detail.task.id);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      notifySuccess("已取消", "任务已标记为取消。");
    } catch (error) {
      notifyError("取消失败", error instanceof Error ? error.message : "无法取消任务");
    } finally {
      setBusyAction(null);
    }
  };

  if (isLoading && !detail) {
    return (
      <div className="mt-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        正在加载 Agent 任务...
      </div>
    );
  }

  if (!detail) return null;

  const canExecute = detail.task.status === "draft";
  const canRetry =
    detail.task.status === "failed" ||
    detail.task.status === "completed" ||
    detail.task.status === "cancelled";
  const canContinue = detail.task.status === "failed" || detail.task.status === "completed";
  const canCancel = detail.task.status === "running";
  const showFullPanels = effectiveUxMode === "full";
  const showInlineError = effectiveUxMode !== "full" && Boolean(streamError);
  const completedStepCount = planSteps.filter((step) => step.status === "completed").length;
  const toolEventCount = executionEvents.filter((event) => {
    const eventType = getExecutionEventType(event);
    return eventType === "tool_start";
  }).length;
  const nonFinalArtifacts = executionArtifacts.filter(
    (artifact) => artifact.type !== "final_result",
  );
  const timelineSteps = buildTimelineSteps({
    detail,
    planSteps,
    visibleExecutionEvents,
    streamError,
  });
  const planMeta =
    planSteps.length > 0
      ? `${completedStepCount}/${planSteps.length} 步已推进`
      : "当前还没有可展示的计划步骤";
  const executionMeta = streamError
    ? "本轮执行出现错误"
    : toolEventCount > 0
      ? `已调用 ${toolEventCount} 个工具`
      : detail.task.status === "running"
        ? "正在执行中"
        : "当前还没有执行日志";
  const artifactMeta =
    executionArtifacts.length > 0
      ? `${executionArtifacts.length} 项结果可查看`
      : detail.task.status === "completed"
        ? "可按需查看结果摘要"
        : "执行完成后会在这里汇总";
  const defaultPlanOpen =
    Boolean(approval) ||
    detail.task.status === "planning" ||
    detail.task.status === "awaiting_approval";
  const defaultExecutionOpen = Boolean(streamError) || detail.task.status === "failed";
  const defaultArtifactsOpen = false;
  const showExecutionSection =
    showFullPanels && (visibleExecutionEvents.length > 0 || Boolean(streamError));
  const showArtifactsSection =
    showFullPanels && (executionArtifacts.length > 0 || detail.task.status === "completed");
  const showActionBar =
    detail.task.status === "draft" ||
    detail.task.status === "failed" ||
    detail.task.status === "cancelled";
  const primaryAction = canExecute
    ? "execute"
    : canContinue
      ? "continue"
      : canRetry
        ? "retry"
        : null;
  const detailToggleLabel = expanded ? "收起详情" : "查看详情";
  const activeTimelineStep =
    timelineSteps.find((step) => step.status === "active") ??
    timelineSteps.find((step) => step.status === "error") ??
    null;
  const compactPrimaryText =
    detail.task.status === "completed"
      ? "Agent 已完成"
      : detail.task.status === "cancelled"
        ? "Agent 已取消"
        : detail.task.status === "failed"
          ? "Agent 执行失败"
          : detail.task.status === "awaiting_approval"
            ? "Agent 等待处理"
            : "Agent 正在处理";
  const compactSecondaryText =
    detail.task.status === "completed" || detail.task.status === "cancelled"
      ? null
      : detail.task.status === "failed"
        ? streamError || "需要查看过程并处理。"
        : activeTimelineStep
          ? `${activeTimelineStep.label}：${activeTimelineStep.description}`
          : inlineSummary;
  const showExpandedMetaPills =
    expanded &&
    (toolEventCount > 0 || executionArtifacts.length > 0 || streamError || planSteps.length > 0);

  return (
    <section className="mt-2 rounded-2xl border border-border/45 bg-muted/5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-[13px] font-medium text-foreground/90">
              {compactPrimaryText}
            </p>
            {detail.task.status === "failed" ? (
              <TaskMetaPill label={TASK_STATUS_LABELS[detail.task.status]} tone="danger" />
            ) : detail.task.status === "awaiting_approval" ? (
              <TaskMetaPill label={TASK_STATUS_LABELS[detail.task.status]} />
            ) : null}
            {busyAction ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          </div>
          {compactSecondaryText ? (
            <p className="mt-1 truncate text-[12px] text-muted-foreground">{compactSecondaryText}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/50 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background"
        >
          <span>{detailToggleLabel}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>

      {!expanded && showInlineError && streamError ? (
        <div className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {streamError}
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-2.5 border-t border-border/50 pt-3">
          <div className="space-y-1">
            {timelineSteps.map((step, index) => (
              <TimelineStepItem
                key={step.id}
                step={step}
                isLast={index === timelineSteps.length - 1}
              />
            ))}
          </div>

          {showExpandedMetaPills ? (
            <div className="flex flex-wrap gap-1.5">
              {planSteps.length > 0 ? <TaskMetaPill label={planMeta} /> : null}
              {toolEventCount > 0 ? <TaskMetaPill label={`${toolEventCount} 个工具`} /> : null}
              {executionArtifacts.length > 0 ? (
                <TaskMetaPill label={`${executionArtifacts.length} 项产物`} />
              ) : null}
              {streamError ? <TaskMetaPill label="执行异常" tone="danger" /> : null}
            </div>
          ) : null}

          {showActionBar ? (
            <div className="rounded-xl border border-border/40 bg-background/45 px-3 py-2.5">
              <div className="mb-2 text-[11px] text-muted-foreground">操作</div>
              <div className="flex flex-wrap gap-2">
                {canExecute ? (
                  <Button
                    size="sm"
                    variant={primaryAction === "execute" ? "default" : "ghost"}
                    className={primaryAction === "execute" ? "" : "text-muted-foreground"}
                    onClick={() =>
                      void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id))
                    }
                    disabled={busyAction !== null}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" />
                    开始执行
                  </Button>
                ) : null}
                {canContinue ? (
                  <Button
                    size="sm"
                    variant={primaryAction === "continue" ? "default" : "ghost"}
                    className={primaryAction === "continue" ? "" : "text-muted-foreground"}
                    onClick={() =>
                      void runExecutionAction("continue", () =>
                        api.agentTasks.continue(detail.task.id),
                      )
                    }
                    disabled={busyAction !== null}
                  >
                    <SkipForward className="mr-1 h-3.5 w-3.5" />
                    继续
                  </Button>
                ) : null}
                {canRetry ? (
                  <Button
                    size="sm"
                    variant={primaryAction === "retry" ? "default" : "ghost"}
                    className={primaryAction === "retry" ? "" : "text-muted-foreground"}
                    onClick={() =>
                      void runExecutionAction("retry", () => api.agentTasks.retry(detail.task.id))
                    }
                    disabled={busyAction !== null}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    重试
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void handleReplan()}
                  disabled={busyAction !== null}
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  重新规划
                </Button>
                {canCancel ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => void handleCancel()}
                    disabled={busyAction !== null}
                  >
                    取消
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {showFullPanels ? (
            <ProcessSection
              title="执行计划"
              meta={planMeta}
              icon={<Sparkles className="h-4 w-4 text-muted-foreground" />}
              defaultOpen={defaultPlanOpen}
            >
              <DesktopPlanPanel
                planSteps={planSteps}
                approval={approval}
                onApprove={() => void handleApproval("approved")}
                onReject={() => void handleApproval("rejected")}
              />
            </ProcessSection>
          ) : approval ? (
            <div className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
              <div className="mb-2 text-[13px] font-medium">{approval.title}</div>
              {approval.description ? (
                <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                  {approval.description}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleApproval("approved")}
                  disabled={busyAction !== null}
                >
                  批准
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void handleApproval("rejected")}
                  disabled={busyAction !== null}
                >
                  拒绝
                </Button>
              </div>
            </div>
          ) : null}

          {showExecutionSection ? (
            <ProcessSection
              title="执行过程"
              meta={executionMeta}
              icon={
                streamError ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <Wrench className="h-4 w-4 text-muted-foreground" />
                )
              }
              defaultOpen={defaultExecutionOpen}
            >
              <DesktopExecutionPanel events={visibleExecutionEvents} streamError={streamError} />
            </ProcessSection>
          ) : null}

          {showArtifactsSection ? (
            <ProcessSection
              title="结果与产物"
              meta={artifactMeta}
              icon={
                nonFinalArtifacts.length > 0 ? (
                  <PackageOpen className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground" />
                )
              }
              defaultOpen={defaultArtifactsOpen}
            >
              <DesktopArtifactsPanel artifacts={executionArtifacts} />
            </ProcessSection>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
