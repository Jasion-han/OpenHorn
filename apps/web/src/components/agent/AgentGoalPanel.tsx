"use client";

import { Paperclip } from "lucide-react";
import type { ApiAgentTask } from "@/lib/api";

export function AgentGoalPanel({ task }: { task: ApiAgentTask }) {
  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-3 text-sm font-medium">任务目标</div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{task.goal}</p>

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
