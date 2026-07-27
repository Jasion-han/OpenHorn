import { displayConversationTitle, formatConversationTime } from "../../lib/conversationTitle";
import type { Conversation } from "../../types/chat";

// Only rendered for an open conversation — the "nothing selected" state is now
// DesktopWelcomeScreen. The sidebar toggle lives in DesktopShellLayout so a
// single control serves every view.
export function DesktopChatHeader({ conversation }: { conversation: Conversation }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{displayConversationTitle(conversation.title)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {formatConversationTime(conversation.createdAt)}
        </p>
      </div>
    </div>
  );
}
