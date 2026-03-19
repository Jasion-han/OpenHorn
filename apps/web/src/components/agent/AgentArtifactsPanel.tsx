"use client";

import { FileText, PackageOpen } from "lucide-react";
import type { ApiAgentArtifact } from "@/lib/api";

export function AgentArtifactsPanel({ artifacts }: { artifacts: ApiAgentArtifact[] }) {
  const finalResult = artifacts.find((artifact) => artifact.type === "final_result") ?? null;

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4" />
          最终结果
        </div>
        {finalResult ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{finalResult.content}</p>
        ) : (
          <p className="text-sm text-muted-foreground">执行完成后，最终结果会单独保存在这里。</p>
        )}
      </section>

      <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <PackageOpen className="h-4 w-4" />
          产物清单
        </div>
        {artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂时没有产物。</p>
        ) : (
          <div className="space-y-3">
            {artifacts.map((artifact) => (
              <div key={artifact.id} className="rounded-2xl border border-border/60 bg-muted/15 p-4">
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

      <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
        <div className="text-sm font-medium">上下文面板</div>
        <p className="mt-2 text-sm text-muted-foreground">
          当前版本先展示最终结果与产物。后续会把 sources、tools、context 拆成独立区域。
        </p>
      </section>
    </div>
  );
}
