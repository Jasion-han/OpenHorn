"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiAgentApproval } from "@/lib/api";

const APPROVAL_STATUS_LABELS: Record<ApiAgentApproval["status"], string> = {
  pending: "等待处理",
  approved: "已批准",
  rejected: "已拒绝",
};

export function AgentApprovalBlock({
  approval,
  onApprove,
  onReject,
}: {
  approval: ApiAgentApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isPending = approval.status === "pending";

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        {approval.status === "approved" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
        ) : approval.status === "rejected" ? (
          <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 text-orange-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{approval.title}</div>
          {approval.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{approval.description}</p>
          ) : null}
          <div className="mt-2 text-xs text-muted-foreground">
            状态：{APPROVAL_STATUS_LABELS[approval.status]}
          </div>
        </div>
      </div>

      {isPending ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={onApprove}>
            批准执行
          </Button>
          <Button size="sm" variant="outline" onClick={onReject}>
            拒绝并返回草稿
          </Button>
        </div>
      ) : null}
    </div>
  );
}
