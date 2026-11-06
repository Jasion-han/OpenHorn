import { Copy, ExternalLink, MoreHorizontal } from "lucide-react";
import { type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "ui";
import { type ChatScrollAnchor, captureUserLinkScrollAnchor } from "../../lib/chatScrollAnchor";
import { getChatLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess } from "../../lib/notify";
import { findKnownSlashToken, type SlashCommandType } from "../../lib/slashToken";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import { findUserMessageLinks, type UserMessageLink } from "../../lib/userMessageLinks";
import { usePreviewPanelStore } from "../../stores/previewPanelStore";
import { SLASH_ICONS } from "./DesktopComposer";

async function openBrowser(url: string) {
  if (isDesktopRuntime()) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch {
      notifyError(getChatLabel("chat.link.openFailed"), getChatLabel("chat.link.retryHint"));
      return;
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function selectedTextTouches(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

function UserMessageAnchor({
  link,
  text,
  index,
}: {
  link: UserMessageLink;
  text: string;
  index: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pointerAnchor = useRef<ChatScrollAnchor | undefined>(undefined);
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    // App.tsx also intercepts anchors; consume this explicit preview action once.
    event.stopPropagation();
    if (event.detail > 0 && selectedTextTouches(event.currentTarget)) return;
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      void openBrowser(link.url);
      return;
    }
    const anchor =
      event.detail > 0
        ? pointerAnchor.current
        : captureUserLinkScrollAnchor(event.currentTarget, index);
    pointerAnchor.current = undefined;
    usePreviewPanelStore.getState().openUrl(link.url, anchor);
  };
  return (
    <span className="group/user-link">
      <a
        href={link.url}
        draggable={false}
        data-chat-user-link-index={index}
        className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 transition-colors hover:decoration-blue-600 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 dark:decoration-blue-400/40"
        onPointerDown={(event) => {
          if (event.button === 0)
            pointerAnchor.current = captureUserLinkScrollAnchor(event.currentTarget, index);
        }}
        onClick={activate}
        onAuxClick={(event) => {
          if (event.button === 1) activate(event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        {text}
      </a>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={getChatLabel("chat.link.more")}
            title={getChatLabel("chat.link.more")}
            className="ml-0.5 inline-flex size-5 items-center justify-center rounded align-middle text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/user-link:opacity-100 group-focus-within/user-link:opacity-100"
          >
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[110]">
          <DropdownMenuItem
            onSelect={() => {
              void openBrowser(link.url);
            }}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {getChatLabel("chat.link.openBrowser")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(link.url).then(
                () => notifySuccess(getChatLabel("chat.link.copied"), link.url),
                () =>
                  notifyError(
                    getChatLabel("chat.link.copyFailed"),
                    getChatLabel("chat.link.retryHint"),
                  ),
              );
            }}
          >
            <Copy aria-hidden="true" className="size-4" />
            {getChatLabel("chat.link.copy")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export function DesktopUserMessageContent({
  content,
  knownCommands,
}: {
  content: string;
  knownCommands?: Map<string, SlashCommandType>;
}) {
  const links = useMemo(() => findUserMessageLinks(content), [content]);
  if (!content.trim()) return null;
  const token = knownCommands ? findKnownSlashToken(content, knownCommands) : null;
  const spans = [
    ...links.map((link, index) => ({
      start: link.start,
      end: link.end,
      node: (
        <UserMessageAnchor
          key={`link-${link.start}`}
          link={link}
          text={content.slice(link.start, link.end)}
          index={index}
        />
      ),
    })),
    ...(token
      ? [
          {
            start: token.start,
            end: token.end,
            node: (() => {
              const Icon = SLASH_ICONS[token.type];
              return (
                <span key={`command-${token.start}`} className="font-medium text-blue-500">
                  <Icon aria-hidden="true" size={14} className="mr-1 inline-block align-[-2px]" />
                  {content.slice(token.start, token.end)}
                </span>
              );
            })(),
          },
        ]
      : []),
  ].sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    nodes.push(content.slice(cursor, span.start), span.node);
    cursor = span.end;
  }
  nodes.push(content.slice(cursor));
  return (
    <p
      className="text-sm"
      style={{
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        maxWidth: "100%",
      }}
    >
      {nodes}
    </p>
  );
}
