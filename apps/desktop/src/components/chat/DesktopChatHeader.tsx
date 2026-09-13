import { displayConversationTitle, formatConversationTime } from "../../lib/conversationTitle";
import type { Conversation } from "../../types/chat";

// Only rendered for an open conversation — the "nothing selected" state is now
// DesktopWelcomeScreen. The sidebar toggle lives in DesktopShellLayout so a
// single control serves every view.
export function DesktopChatHeader({ conversation }: { conversation: Conversation }) {
  return (
    <div data-tauri-drag-region className="mb-3 flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        {/* 18px medium, not 16px semibold: on a 1x display the thin top features of
            CJK glyphs (the two ticks of 获's 艹, say) fall below half a pixel at 16px
            and merge into the stroke below, so the character reads as shaved off.
            The larger size resolves them; the lighter weight keeps them apart. */}
        <p className="truncate font-medium text-lg">
          {displayConversationTitle(conversation.title)}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatConversationTime(conversation.createdAt)}
        </p>
      </div>
    </div>
  );
}
