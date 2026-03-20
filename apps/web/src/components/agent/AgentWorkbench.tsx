"use client";

import { useEffect, useState } from "react";
import { Bot, ClipboardList, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { ApiAgentApproval, ApiAgentTaskDetail, ApiAgentTaskRun } from "@/lib/api";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { AgentArtifactsPanel } from "./AgentArtifactsPanel";
import { AgentExecutionPanel } from "./AgentExecutionPanel";
import { AgentGoalPanel } from "./AgentGoalPanel";
import { AgentPlanPanel } from "./AgentPlanPanel";
import { AgentRunSelector, type AgentRunSummary } from "./AgentRunSelector";
import { AgentTaskHeader } from "./AgentTaskHeader";
import { AgentTaskList } from "./AgentTaskList";

function findPlanningRunForSelection(detail: ApiAgentTaskDetail, selectedRun: ApiAgentTaskRun | null) {
  if (!selectedRun) return null;
  if (selectedRun.phase === "planning") return selectedRun;

  const planningRuns = detail.runs.filter((run) => run.phase === "planning");
  return (
    planningRuns.find((run) => run.createdAt <= selectedRun.createdAt) ??
    planningRuns[0] ??
    null
  );
}

function getSelectedApproval(detail: ApiAgentTaskDetail, selectedRun: ApiAgentTaskRun | null) {
  if (!selectedRun) return null;

  const runApprovals = detail.approvals.filter((approval) => approval.runId === selectedRun.id);
  if (runApprovals.length > 0) {
    return runApprovals[0] ?? null;
  }

  const planningRun = findPlanningRunForSelection(detail, selectedRun);
  if (!planningRun) return null;
  const planningApprovals = detail.approvals.filter(
    (approval) => approval.runId === planningRun.id && approval.type === "plan_approval",
  );
  return planningApprovals[0] ?? null;
}

function getRunLabel(run: ApiAgentTaskRun | null) {
  if (!run) return null;
  return `${run.phase === "planning" ? "规划" : "执行"} #${run.id.slice(0, 6)}`;
}

function getRunSummaries(detail: ApiAgentTaskDetail): AgentRunSummary[] {
  return detail.runs.map((run) => {
    const runEvents = detail.events.filter((event) => event.runId === run.id);
    const runArtifacts = detail.artifacts.filter((artifact) => artifact.runId === run.id);
    const toolStarts = runEvents.filter((event) => {
      if (event.type !== "execution_event") return false;
      if (typeof event.metadata !== "object" || !event.metadata) return false;
      return (event.metadata as Record<string, unknown>).eventType === "tool_start";
    }).length;
    const finalResult = runArtifacts.find((artifact) => artifact.type === "final_result") ?? null;
    const executionSummary =
      runArtifacts.find((artifact) => artifact.type === "execution_summary") ?? null;
    const planStepCount = detail.planSteps.filter((step) => step.runId === run.id).length;

    const summarySource =
      run.error?.trim() ||
      run.summary?.trim() ||
      finalResult?.content.trim() ||
      executionSummary?.content.trim() ||
      (run.phase === "planning" && planStepCount > 0 ? `共生成 ${planStepCount} 个计划步骤。` : "");

    return {
      runId: run.id,
      toolStarts,
      hasFinalResult: Boolean(finalResult),
      summary: summarySource ? summarySource.slice(0, 160) : null,
    };
  });
}

export function AgentWorkbench() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const {
    tasks,
    selectedTaskId,
    detail,
    isLoading,
    isRefreshingDetail,
    isCreating,
    isPlanning,
    isExecuting,
    isSavingGoal,
    draftTitle,
    draftGoal,
    streamError,
    loadTasks,
    selectTask,
    refreshTask,
    setDraftTitle,
    setDraftGoal,
    createTask,
    requestPlan,
    respondApproval,
    executeTask,
    retryTask,
    continueTask,
    replanTask,
    saveTaskGoal,
    cancelTask,
  } = useAgentTaskStore();

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (detail?.task.status !== "running" && detail?.task.status !== "awaiting_approval") return;

    const intervalId = window.setInterval(() => {
      void refreshTask(detail.task.id, { silent: true });
    }, 4000);

    const handleFocusRefresh = () => {
      void refreshTask(detail.task.id, { silent: true });
    };

    window.addEventListener("focus", handleFocusRefresh);
    document.addEventListener("visibilitychange", handleFocusRefresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocusRefresh);
      document.removeEventListener("visibilitychange", handleFocusRefresh);
    };
  }, [detail?.task.id, detail?.task.status, refreshTask]);

  useEffect(() => {
    if (!detail) {
      setSelectedRunId(null);
      return;
    }

    const selectedStillExists = selectedRunId
      ? detail.runs.some((run) => run.id === selectedRunId)
      : false;
    if (!selectedStillExists) {
      setSelectedRunId(detail.runs[0]?.id ?? null);
    }
  }, [detail, selectedRunId]);

  const latestPlanApproval =
    detail?.approvals.find((approval) => approval.type === "plan_approval") ?? null;
  const latestApproval = detail?.approvals[0] ?? null;
  const hasApprovedPlan = latestPlanApproval?.status === "approved";
  const hasPlan = Boolean(detail?.planSteps.length);
  const canRetry =
    !!detail &&
    hasApprovedPlan &&
    ["failed", "cancelled", "completed"].includes(detail.task.status) &&
    !isExecuting &&
    !isPlanning;
  const canContinue =
    !!detail &&
    hasApprovedPlan &&
    ["failed", "completed"].includes(detail.task.status) &&
    !isExecuting &&
    !isPlanning;
  const selectedRun = detail?.runs.find((run) => run.id === selectedRunId) ?? detail?.runs[0] ?? null;
  const planningRun = detail ? findPlanningRunForSelection(detail, selectedRun) : null;
  const selectedApproval: ApiAgentApproval | null = detail ? getSelectedApproval(detail, selectedRun) : null;
  const runSummaries = detail ? getRunSummaries(detail) : [];
  const selectedPlanSteps =
    detail && planningRun ? detail.planSteps.filter((step) => step.runId === planningRun.id) : [];
  const selectedEvents =
    detail && selectedRun?.phase === "execution"
      ? detail.events.filter((event) => event.runId === selectedRun.id)
      : [];
  const selectedArtifacts =
    detail && selectedRun?.phase === "execution"
      ? detail.artifacts.filter((artifact) => artifact.runId === selectedRun.id)
      : [];
  const selectedStreamError =
    detail &&
    selectedRun &&
    detail.runs[0]?.id === selectedRun.id &&
    selectedRun.phase === "execution"
      ? streamError
      : null;

  return (
    <div className="h-full min-h-0">
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[300px,minmax(0,1fr),340px]">
        <section className="flex min-h-0 flex-col rounded-3xl border border-border/70 bg-gradient-to-b from-background via-background to-muted/20 p-4">
          <div className="mb-4 flex items-center gap-2">
            <ClipboardList className="h-4 w-4" />
            <div className="text-sm font-medium">任务列表</div>
          </div>

          <div className="mb-4 rounded-2xl border border-border/70 bg-background/80 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4" />
              新建任务
            </div>
            <div className="space-y-3">
              <Input
                placeholder="任务标题，可选"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
              <Textarea
                placeholder="描述你希望 Agent 完成什么。"
                value={draftGoal}
                onChange={(event) => setDraftGoal(event.target.value)}
                className="min-h-[128px]"
              />
              <Button className="w-full" onClick={() => void createTask()} disabled={isCreating}>
                <Plus className="mr-2 h-4 w-4" />
                {isCreating ? "创建中" : "创建任务"}
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <AgentTaskList
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelect={(taskId) => void selectTask(taskId)}
            />
          </div>
        </section>

        <section className="min-h-0 rounded-3xl border border-border/70 bg-gradient-to-b from-background via-background to-muted/20">
          <ScrollArea className="h-full">
            <div className="space-y-3 p-4">
              {detail ? (
                <>
                  <AgentTaskHeader
                    task={detail.task}
                    hasApprovedPlan={hasApprovedPlan}
                    hasPlan={hasPlan}
                    canRetry={canRetry}
                    canContinue={canContinue}
                    isPlanning={isPlanning}
                    isExecuting={isExecuting}
                    isRefreshingDetail={isRefreshingDetail}
                    onPlan={() => void requestPlan()}
                    onReplan={() => void replanTask()}
                    onRetry={() => void retryTask()}
                    onContinue={() => void continueTask()}
                    onExecute={() => void executeTask()}
                    onCancel={() => void cancelTask()}
                    onRefresh={() => void refreshTask(detail.task.id)}
                  />
                  <AgentRunSelector
                    runs={detail.runs}
                    summaries={runSummaries}
                    selectedRunId={selectedRun?.id ?? null}
                    onSelect={setSelectedRunId}
                  />
                  <AgentGoalPanel
                    task={detail.task}
                    isSaving={isSavingGoal}
                    canEdit={
                      !isPlanning &&
                      !isExecuting &&
                      detail.task.status !== "running" &&
                      detail.task.status !== "planning" &&
                      !(detail.task.status === "awaiting_approval" && latestApproval?.type === "tool_approval")
                    }
                    onSave={saveTaskGoal}
                  />
                  <AgentPlanPanel
                    planSteps={selectedPlanSteps}
                    approval={selectedApproval}
                    onApprove={(approvalId) => void respondApproval(approvalId, "approved", { source: "web" })}
                    onReject={(approvalId) => void respondApproval(approvalId, "rejected", { source: "web" })}
                  />
                  <AgentExecutionPanel
                    events={selectedEvents}
                    streamError={selectedStreamError}
                    runLabel={getRunLabel(selectedRun)}
                  />
                </>
              ) : (
                <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-dashed border-border/70 bg-background/70 p-10 text-center">
                  <div className="max-w-md">
                    <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
                    <div className="mt-4 text-lg font-medium">
                      {isLoading ? "正在加载任务" : "选择一个任务开始工作"}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      这里会显示任务目标、结构化计划、审批状态、执行日志和最终结果。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </section>

        <section className="min-h-0 rounded-3xl border border-border/70 bg-gradient-to-b from-background via-background to-muted/20">
          <ScrollArea className="h-full">
            <div className="p-4">
              <AgentArtifactsPanel artifacts={selectedArtifacts} />
            </div>
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
