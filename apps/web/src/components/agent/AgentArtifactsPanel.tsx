"use client";

import { FileText, PackageOpen } from "lucide-react";
import type { ApiAgentArtifact } from "@/lib/api";

function compactText(text: string, limit: number) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

export function AgentArtifactsPanel({
  artifacts,
  embedded = false,
}: {
  artifacts: ApiAgentArtifact[];
  embedded?: boolean;
}) {
  const finalResult = artifacts.find((artifact) => artifact.type === "final_result") ?? null;
  const summaryArtifact =
    finalResult ?? artifacts.find((artifact) => artifact.type === "execution_summary") ?? null;
  const nonSummaryArtifacts = artifacts.filter(
    (artifact) => artifact.type !== "final_result" && artifact.type !== "execution_summary",
  );
  const containerClassName = embedded
    ? "rounded-2xl border border-border/60 bg-muted/10 p-4"
    : "rounded-3xl border border-border/70 bg-background/80 p-5";

  if (embedded) {
    return (
      <div className="space-y-4">
        <section className={containerClassName}>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4" />
            结果摘要
          </div>
          {summaryArtifact ? (
            <p className="text-sm leading-6 text-foreground/90">
              {compactText(summaryArtifact.content, summaryArtifact.type === "execution_summary" ? 180 : 220)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">当前运行还没有可展示的摘要。</p>
          )}
        </section>

        {nonSummaryArtifacts.length > 0 ? (
          <section className={containerClassName}>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <PackageOpen className="h-4 w-4" />
              产物列表
            </div>
            <div className="flex flex-wrap gap-2">
              {nonSummaryArtifacts.map((artifact) => (
                <span
                  key={artifact.id}
                  className="rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs text-muted-foreground"
                >
                  {artifact.title}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className={containerClassName}>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4" />
          最终结果
        </div>
        {finalResult ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{finalResult.content}</p>
        ) : (
          <p className="text-sm text-muted-foreground">当前运行没有单独保存的最终结果。</p>
        )}
      </section>

      <section className={containerClassName}>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <PackageOpen className="h-4 w-4" />
          产物清单
        </div>
        {artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前运行暂时没有产物。</p>
        ) : (
          <div className="space-y-3">
            {artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className={embedded ? "rounded-2xl border border-border/60 bg-background/70 p-4" : "rounded-2xl border border-border/60 bg-muted/15 p-4"}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">{artifact.title}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {artifact.type}
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                  {artifact.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={containerClassName}>
        <div className="text-sm font-medium">上下文面板</div>
        <p className="mt-2 text-sm text-muted-foreground">
          当前版本先展示最终结果与产物。后续会把 sources、tools、context 拆成独立区域。
        </p>
      </section>
    </div>
  );
}
