import { ArrowRight, FileOutput, Play, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SavedArtifact, TaskRecipe } from "shared/types";
import { cn } from "ui";
import { getWorkbenchLabel } from "../../lib/i18n/agent";
import { workbenchApi } from "../../lib/workbenchApi";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";

const label = getWorkbenchLabel;

export function WorkbenchHome() {
  const [recipes, setRecipes] = useState<TaskRecipe[]>([]);
  const [artifacts, setArtifacts] = useState<SavedArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const conversations = useChatStore((state) => state.conversations);
  const recent = useMemo(() => conversations.slice(0, 3), [conversations]);
  const setTab = useWorkbenchStore((state) => state.setTab);
  useEffect(() => {
    let active = true;
    Promise.all([workbenchApi.recipes.list(), workbenchApi.artifacts.list()])
      .then(([recipeResult, artifactResult]) => {
        if (!active) return;
        setRecipes(recipeResult.recipes.slice(0, 4));
        setArtifacts(artifactResult.artifacts.slice(0, 4));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="space-y-5">
      <section className="grid gap-3 md:grid-cols-[1.35fr_1fr_1fr]">
        <button
          type="button"
          onClick={() => useDesktopShellStore.getState().setActiveView("chat")}
          className="group min-h-44 rounded-2xl border bg-foreground p-5 text-left text-background transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sparkles className="size-5 text-background/70" />
          <div className="mt-12 flex items-end justify-between gap-4">
            <span>
              <span className="block text-lg font-medium">{label("workbench.home.start")}</span>
              <span className="mt-1 block text-sm text-background/60">
                {label("workbench.home.startHint")}
              </span>
            </span>
            <ArrowRight className="size-5 shrink-0 transition-transform group-hover:translate-x-1" />
          </div>
        </button>
        <button
          type="button"
          onClick={() => setTab("recipes")}
          className="min-h-44 rounded-2xl border bg-background p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Play className="size-5 text-muted-foreground" />
          <span className="mt-12 block text-sm font-medium">{label("workbench.home.recipes")}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {recipes.length} {label("workbench.home.saved")}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab("artifacts")}
          className="min-h-44 rounded-2xl border bg-background p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FileOutput className="size-5 text-muted-foreground" />
          <span className="mt-12 block text-sm font-medium">
            {label("workbench.home.artifacts")}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {artifacts.length} {label("workbench.home.saved")}
          </span>
        </button>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border bg-background p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{label("workbench.home.recent")}</h2>
            <Search className="size-4 text-muted-foreground" />
          </div>
          {recent.length ? (
            <div className="divide-y">
              {recent.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    void useChatStore.getState().selectConversation(conversation.id);
                    useDesktopShellStore.getState().setActiveView("chat");
                  }}
                  className="flex w-full items-center justify-between gap-3 py-3 text-left hover:text-foreground"
                >
                  <span className="truncate text-sm">{conversation.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {conversation.updatedAt.toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">{label("workbench.home.noRecent")}</p>
          )}
        </section>
        <section className="rounded-2xl border bg-background p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{label("workbench.home.latest")}</h2>
            <FileOutput className="size-4 text-muted-foreground" />
          </div>
          {loading ? (
            <p className="py-8 text-sm text-muted-foreground">…</p>
          ) : artifacts.length ? (
            <div className="space-y-2">
              {artifacts.slice(0, 3).map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => useWorkbenchStore.getState().openItem("artifacts", artifact.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg bg-muted/30 px-3 py-3 text-left hover:bg-muted/60",
                  )}
                >
                  <span className="truncate text-sm">{artifact.title}</span>
                  <span className="text-xs text-muted-foreground">v{artifact.currentVersion}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">{label("workbench.home.noLatest")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
