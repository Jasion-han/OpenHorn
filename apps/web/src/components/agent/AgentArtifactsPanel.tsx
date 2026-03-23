"use client";

import { FileText, PackageOpen } from "lucide-react";
import type { ApiAgentArtifact } from "@/lib/api";
import { CitationList } from "@/components/ui/CitationList";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { getArtifactCitations, sanitizeDisplayContent } from "@/lib/citations";

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
  const finalResultCitations = getArtifactCitations(finalResult);
  const finalResultDisplay = finalResult
    ? sanitizeDisplayContent(finalResult.content, finalResultCitations)
    : "";
  const summaryCitations =
    summaryArtifact?.type === "final_result" ? getArtifactCitations(summaryArtifact) : undefined;
  const summaryDisplay = summaryArtifact
    ? sanitizeDisplayContent(summaryArtifact.content, summaryCitations)
    : "";
  const containerClassName = embedded
    ? "rounded-xl border border-border/45 bg-background/55 px-3 py-2.5"
    : "rounded-3xl border border-border/70 bg-background/80 p-5";

  if (embedded) {
    return (
      <div className="space-y-3">
        <section className={containerClassName}>
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-foreground/85">
            <FileText className="h-4 w-4" />
            结果
          </div>
          {summaryArtifact ? (
            summaryArtifact.type === "final_result" ? (
              <div className="space-y-2.5">
                <div className="min-w-0 text-[12px] leading-5 text-foreground/90">
                  <MarkdownMessage content={summaryDisplay} citations={summaryCitations} />
                </div>
                <CitationList citations={summaryCitations} content={summaryDisplay} />
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
          <section className={containerClassName}>
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

  return (
    <div className="space-y-4">
      <section className={containerClassName}>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4" />
          最终结果
        </div>
        {finalResult ? (
          <div className="space-y-3">
            <div className="min-w-0 text-sm leading-6 text-foreground/90">
              <MarkdownMessage content={finalResultDisplay} citations={finalResultCitations} />
            </div>
            <CitationList citations={finalResultCitations} content={finalResultDisplay} />
          </div>
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
