"use client";

import { useEffect } from "react";
import { Bot, ClipboardList, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { AgentArtifactsPanel } from "./AgentArtifactsPanel";
import { AgentExecutionPanel } from "./AgentExecutionPanel";
import { AgentGoalPanel } from "./AgentGoalPanel";
import { AgentPlanPanel } from "./AgentPlanPanel";
import { AgentTaskHeader } from "./AgentTaskHeader";
import { AgentTaskList } from "./AgentTaskList";

export function AgentWorkbench() {
  const {
    tasks,
    selectedTaskId,
    detail,
    isLoading,
    isCreating,
    isPlanning,
    isExecuting,
    draftTitle,
    draftGoal,
    streamError,
    loadTasks,
    selectTask,
    setDraftTitle,
    setDraftGoal,
    createTask,
    requestPlan,
    respondApproval,
    executeTask,
    cancelTask,
  } = useAgentTaskStore();

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const latestPlanApproval =
    detail?.approvals.find((approval) => approval.type === "plan_approval") ?? null;
  const hasApprovedPlan = latestPlanApproval?.status === "approved";

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
                    isPlanning={isPlanning}
                    isExecuting={isExecuting}
                    onPlan={() => void requestPlan()}
                    onExecute={() => void executeTask()}
                    onCancel={() => void cancelTask()}
                  />
                  <AgentGoalPanel task={detail.task} />
                  <AgentPlanPanel
                    planSteps={detail.planSteps}
                    approvals={detail.approvals}
                    onApprove={(approvalId) => void respondApproval(approvalId, "approved", { source: "web" })}
                    onReject={(approvalId) => void respondApproval(approvalId, "rejected", { source: "web" })}
                  />
                  <AgentExecutionPanel events={detail.events} streamError={streamError} />
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
              <AgentArtifactsPanel artifacts={detail?.artifacts ?? []} />
            </div>
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
