"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiAgentApproval } from "@/lib/api";

const APPROVAL_STATUS_LABELS: Record<ApiAgentApproval["status"], string> = {
  pending: "等待处理",
  approved: "已批准",
  rejected: "已拒绝",
};

type ToolApprovalPayload = {
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  blockedPath?: string | null;
  decisionReason?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function summarizeToolInput(toolInput: Record<string, unknown> | undefined) {
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

  if (lines.length > 0) {
    return lines.join("\n");
  }

  try {
    return JSON.stringify(toolInput, null, 2);
  } catch {
    return null;
  }
}

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
  const approveLabel = approval.type === "tool_approval" ? "批准继续" : "批准执行";
  const rejectLabel = approval.type === "tool_approval" ? "拒绝本次工具调用" : "拒绝并返回草稿";
  const toolPayload = approval.type === "tool_approval" ? getToolApprovalPayload(approval.payload) : null;
  const toolSummary = summarizeToolInput(toolPayload?.toolInput);
  const statusToneClassName =
    approval.status === "approved"
      ? "border-emerald-200/70 bg-emerald-50/50"
      : approval.status === "rejected"
        ? "border-destructive/20 bg-destructive/5"
        : "border-orange-200/70 bg-orange-50/45";

  return (
    <div
      id="agent-approval-block"
      className={`rounded-xl border px-3 py-2.5 ${statusToneClassName}`}
    >
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
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{approval.description}</p>
          ) : null}
          <div className="mt-2 inline-flex rounded-full border border-border/40 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            {APPROVAL_STATUS_LABELS[approval.status]}
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
              <p className="mt-0.5 text-[12px] leading-5 text-foreground/90">{toolPayload.decisionReason}</p>
            </div>
          ) : null}

          {toolPayload.blockedPath ? (
            <div className="rounded-lg border border-border/45 bg-background/75 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">受限路径</div>
              <p className="mt-0.5 break-all font-mono text-[11px] text-foreground/90">{toolPayload.blockedPath}</p>
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
