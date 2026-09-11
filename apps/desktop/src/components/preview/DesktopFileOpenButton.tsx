import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui";
import { formatPreviewLabel, getPreviewLabel } from "../../lib/i18n/agent";
import { isTextLikePath } from "../../lib/referenceLink";
import { openWorkspaceFile, pickEditorApp, revealWorkspaceFile } from "../../lib/tauriBridge";
import { useChatStore } from "../../stores/chatStore";
import {
  editorNameFromAppPath,
  type ResolvedEditor,
  useExternalEditorStore,
} from "../../stores/externalEditorStore";
import { resolveProjectRootForConversation } from "../../stores/projectStore";
import { useSidecarStore } from "../../stores/sidecarStore";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The root the file path is relative to: the project folder of the
 * conversation the tab came from, falling back to the sidecar's current
 * workspace. Using only the latter would resolve against whichever project
 * the user switched to since opening the tab.
 */
function resolveOpenRoot(conversationId: string | null): string | null {
  const chat = useChatStore.getState();
  const conversation =
    chat.conversations.find((c) => c.id === conversationId) ??
    (chat.currentConversation?.id === conversationId ? chat.currentConversation : null);
  return (
    resolveProjectRootForConversation(conversation) ?? useSidecarStore.getState().workspaceRoot
  );
}

/**
 * Split button in the file preview toolbar: the main part opens the file
 * with the user's remembered editor (or, for non-text files, the OS default
 * app); the chevron lists installed editors, one-off alternatives and
 * "reveal in Finder". Picking an editor from the list opens the file and
 * becomes the preference, so the choice only has to be made once.
 */
export function DesktopFileOpenButton({
  path,
  line,
  conversationId,
  onError,
}: {
  path: string;
  line?: number;
  conversationId: string | null;
  onError: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const preference = useExternalEditorStore((state) => state.preference);
  const detected = useExternalEditorStore((state) => state.detected);
  const detectStatus = useExternalEditorStore((state) => state.detectStatus);
  const setPreference = useExternalEditorStore((state) => state.setPreference);
  const detect = useExternalEditorStore((state) => state.detect);

  useEffect(() => {
    void detect();
  }, [detect]);

  const textLike = useMemo(() => isTextLikePath(path), [path]);
  // Derived from preference + detected so the selector never returns a fresh object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preference/detected are the inputs of resolveEditor
  const resolved = useMemo(
    () => (textLike ? useExternalEditorStore.getState().resolveEditor() : null),
    [textLike, preference, detected],
  );

  const mainLabel = !textLike
    ? getPreviewLabel("preview.file.openWithDefault")
    : resolved
      ? formatPreviewLabel("preview.file.openInEditor", { editor: resolved.name })
      : getPreviewLabel("preview.file.openInEditorUnset");

  const launch = useCallback(
    async (editor: ResolvedEditor | null) => {
      const workspaceRoot = resolveOpenRoot(conversationId);
      if (!workspaceRoot) {
        onError(getPreviewLabel("preview.file.noWorkspace"));
        return;
      }
      try {
        await openWorkspaceFile(workspaceRoot, path, editor ? { line, editor } : undefined);
      } catch (error) {
        onError(
          formatPreviewLabel("preview.file.openExternalFailed", { message: describeError(error) }),
        );
      }
    },
    [path, line, conversationId, onError],
  );

  const handleMain = useCallback(() => {
    if (!textLike) {
      void launch(null);
      return;
    }
    if (resolved) {
      void launch(resolved);
      return;
    }
    setMenuOpen(true);
  }, [textLike, resolved, launch]);

  const handleChooseApp = useCallback(async () => {
    const appPath = await pickEditorApp();
    if (!appPath) return;
    // One-off: does not touch the preference (that is what the settings page
    // and the detected-editor rows are for).
    await launch({ name: editorNameFromAppPath(appPath), appPath });
  }, [launch]);

  const handleReveal = useCallback(async () => {
    const workspaceRoot = resolveOpenRoot(conversationId);
    if (!workspaceRoot) {
      onError(getPreviewLabel("preview.file.noWorkspace"));
      return;
    }
    try {
      await revealWorkspaceFile(workspaceRoot, path);
    } catch (error) {
      onError(formatPreviewLabel("preview.file.revealFailed", { message: describeError(error) }));
    }
  }, [path, conversationId, onError]);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="flex shrink-0 items-stretch rounded-md border border-border/60">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-r-none px-2 text-[11px]"
          title={mainLabel}
          onClick={handleMain}
        >
          <span className="max-w-[160px] truncate">{mainLabel}</span>
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="w-5 rounded-l-none border-l border-border/60"
            aria-label={getPreviewLabel("preview.file.openMenu")}
            title={getPreviewLabel("preview.file.openMenu")}
          >
            <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-56">
        {textLike ? (
          <>
            {detected.map((editor) => {
              const selected = preference?.kind === "detected" && preference.id === editor.id;
              return (
                <DropdownMenuItem
                  key={editor.id}
                  onSelect={() => {
                    setPreference({ kind: "detected", id: editor.id });
                    void launch({ id: editor.id, name: editor.name, appPath: editor.appPath });
                  }}
                >
                  <Check size={14} className={cn(!selected && "invisible")} />
                  {editor.name}
                </DropdownMenuItem>
              );
            })}
            {detected.length === 0 && detectStatus === "done" ? (
              <DropdownMenuItem disabled>
                {getPreviewLabel("preview.file.menu.noEditors")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => void launch(null)}>
          {getPreviewLabel("preview.file.menu.systemDefault")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleChooseApp()}>
          {getPreviewLabel("preview.file.menu.chooseApp")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleReveal()}>
          {getPreviewLabel("preview.file.menu.reveal")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
