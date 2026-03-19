"use client";

import { useEffect, useState } from "react";
import { Paperclip, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ApiAgentTask } from "@/lib/api";

export function AgentGoalPanel({
  task,
  isSaving,
  canEdit,
  onSave,
}: {
  task: ApiAgentTask;
  isSaving: boolean;
  canEdit: boolean;
  onSave: (goal: string) => Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftGoal, setDraftGoal] = useState(task.goal);

  useEffect(() => {
    setDraftGoal(task.goal);
    setIsEditing(false);
  }, [task.id, task.goal]);

  const hasChanged = draftGoal.trim() !== task.goal.trim();

  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">任务目标</div>
          <p className="mt-1 text-xs text-muted-foreground">
            更新目标后，旧计划会失效，需要重新规划。
          </p>
        </div>
        {!isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} disabled={!canEdit}>
            <PencilLine className="mr-2 h-4 w-4" />
            编辑目标
          </Button>
        ) : null}
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <Textarea
            value={draftGoal}
            onChange={(event) => setDraftGoal(event.target.value)}
            className="min-h-[140px]"
            disabled={isSaving}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={isSaving || !hasChanged || !draftGoal.trim()}
              onClick={async () => {
                const saved = await onSave(draftGoal);
                if (saved) {
                  setIsEditing(false);
                }
              }}
            >
              {isSaving ? "保存中" : "保存目标"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setDraftGoal(task.goal);
                setIsEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{task.goal}</p>
      )}

      {task.attachments.length > 0 ? (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">附件</div>
          <div className="flex flex-wrap gap-2">
            {task.attachments.map((attachment, index) => (
              <div
                key={`${attachment.id || attachment.fileName}-${index}`}
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/20 px-3 py-1.5 text-xs"
              >
                <Paperclip className="h-3.5 w-3.5" />
                <span>{attachment.fileName}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
