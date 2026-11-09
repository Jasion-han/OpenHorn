import { useEffect, useRef } from "react";
import type { ArtifactVersion, SavedArtifact } from "shared/types";
import { Button, cn } from "ui";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { formatWorkbenchLabel, getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { notifyError } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { workbenchError } from "../../lib/workbenchApi";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import { ArtifactPanel, artifactPreviewContent } from "./ArtifactPanel";
import { RecipePanel } from "./RecipePanel";
import { ReviewWorkspacePanel } from "./reviews/ReviewWorkspacePanel";

const api = createServerApi();
export function WorkbenchView() {
  const tab = useWorkbenchStore((s) => s.tab);
  const setTab = useWorkbenchStore((s) => s.setTab);
  const artifactRefresh = useWorkbenchStore((s) => s.artifactRefresh);
  const continuing = useRef(false);
  const operationEpoch = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing tabs invalidates pending navigation even when this component stays mounted
  useEffect(() => {
    operationEpoch.current++;
    return () => {
      operationEpoch.current++;
    };
  }, [tab]);
  const ownsNavigation = (epoch: number) =>
    operationEpoch.current === epoch &&
    useDesktopShellStore.getState().activeView === "workbench" &&
    useWorkbenchStore.getState().tab === "artifacts";
  const openSource = async (conversationId: string) => {
    const epoch = ++operationEpoch.current;
    try {
      await useChatStore.getState().selectConversation(conversationId);
      if (!ownsNavigation(epoch)) return;
      useDesktopShellStore.getState().setActiveView("chat");
    } catch (error) {
      notifyError(label("workbench.artifacts.failed"), workbenchError(error));
    }
  };
  const continueArtifact = async (artifact: SavedArtifact, version: ArtifactVersion) => {
    if (continuing.current) return;
    if (useChatStore.getState().isStreaming) {
      notifyError(label("workbench.artifacts.failed"), label("workbench.recipes.running"));
      return;
    }
    const model = getGlobalDefaultChannel(useChatStore.getState().channels);
    if (!model) {
      notifyError(label("workbench.artifacts.failed"), label("workbench.errors.channelMissing"));
      return;
    }
    continuing.current = true;
    const epoch = ++operationEpoch.current;
    try {
      const content = artifactPreviewContent(version);
      const result = await api.conversations.create({
        title: artifact.title,
        channelId: model.channelId,
        modelId: model.modelId,
        defaultMode: "agent",
        projectId: artifact.projectId,
        forceNew: true,
      });
      // Navigation cancels the handoff rather than sending a deferred prompt unexpectedly.
      if (!ownsNavigation(epoch)) return;
      await useChatStore.getState().loadConversations();
      if (!ownsNavigation(epoch)) return;
      await useChatStore.getState().selectConversation(result.conversation.id);
      if (
        !ownsNavigation(epoch) ||
        useChatStore.getState().currentConversation?.id !== result.conversation.id
      )
        return;
      useDesktopShellStore.getState().setPendingPrompt({
        text: formatWorkbenchLabel("workbench.artifacts.continuePrompt", {
          title: artifact.title,
          version: version.version,
          content,
        }),
        files: [],
        conversationId: result.conversation.id,
        autoSend: false,
      });
      useDesktopShellStore.getState().setActiveView("chat");
    } catch (error) {
      notifyError(label("workbench.artifacts.failed"), workbenchError(error));
    } finally {
      continuing.current = false;
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-tauri-drag-region className="h-8 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
            <div className="min-w-0 space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">{label("workbench.title")}</h1>
              <p className="text-sm text-muted-foreground">
                {label(
                  tab === "recipes"
                    ? "workbench.recipes.roleDescription"
                    : tab === "reviews"
                      ? "reviews.description"
                      : "workbench.artifacts.roleDescription",
                )}
              </p>
            </div>
            <div className="flex gap-1 rounded-md bg-muted/50 p-0.5">
              {(["recipes", "artifacts", "reviews"] as const).map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  aria-pressed={tab === value}
                  size="sm"
                  className={cn("px-3", tab === value && "bg-background shadow-sm")}
                  onClick={() => setTab(value)}
                >
                  {label(
                    value === "recipes"
                      ? "workbench.recipes.title"
                      : value === "reviews"
                        ? "reviews.title"
                        : "workbench.artifacts.title",
                  )}
                </Button>
              ))}
            </div>
          </header>
          {tab === "recipes" ? (
            <RecipePanel />
          ) : tab === "reviews" ? (
            <ReviewWorkspacePanel />
          ) : (
            <ArtifactPanel
              refreshToken={artifactRefresh}
              onContinue={continueArtifact}
              onOpenSource={openSource}
            />
          )}
        </div>
      </div>
    </div>
  );
}
