import { Bot, MessageSquare } from "lucide-react";
import { ScrollArea, cn } from "ui";
import { readSseStream } from "../../lib/sse";
import { useChatStore } from "../../stores/chatStore";
import { DesktopChatHeader } from "./DesktopChatHeader";
import { DesktopComposer } from "./DesktopComposer";

export function DesktopChatArea() {
  const currentConversation = useChatStore((state) => state.currentConversation);
  const messages = useChatStore((state) => state.messages);
  const isLoading = useChatStore((state) => state.isLoading);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const appendMessageDelta = useChatStore((state) => state.appendMessageDelta);
  const loadMessages = useChatStore((state) => state.loadMessages);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setError = useChatStore((state) => state.setError);

  const handleSubmit = async (content: string) => {
    if (!currentConversation) return;

    const { assistantMessageId, response } = await sendMessage({ content });

    try {
      await readSseStream(response, (event) => {
        if (event.type === "delta") {
          appendMessageDelta(assistantMessageId, event.content || "");
          return;
        }

        if (event.type === "error") {
          setError(event.message || "Stream error");
          setStreaming(false);
          return;
        }
      });

      setStreaming(false);
      await Promise.all([loadMessages(currentConversation.id), loadConversations()]);
    } catch (error) {
      updateMessage(assistantMessageId, {
        content: error instanceof Error ? error.message : "Stream error",
      });
      setStreaming(false);
      setError(error instanceof Error ? error.message : "Stream error");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DesktopChatHeader conversation={currentConversation} />

      <div className="min-h-0 flex-1">
        {!currentConversation ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-[28px] border border-border/60 bg-background/70 px-6 py-8 text-center shadow-sm">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <MessageSquare size={20} />
              </div>
              <div className="mt-4 text-lg font-semibold">桌面端聊天壳已对齐 Web 结构</div>
              <p className="mt-2 text-sm text-muted-foreground">
                左侧管理会话，中间完成聊天与 Agent 模式切换，不再保留旧三栏 IDE 主界面。
              </p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex min-h-full flex-col gap-3 px-4 py-4">
              {messages.length === 0 && !isLoading && (
                <div className="rounded-2xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">
                  这个会话还没有消息，直接在下方输入即可。
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-[88%] rounded-[24px] border px-4 py-3 shadow-sm",
                    message.role === "user"
                      ? "ml-auto border-foreground/10 bg-foreground text-background"
                      : "border-border/60 bg-background/85 text-foreground",
                  )}
                >
                  <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] opacity-70">
                    {message.role === "assistant" ? <Bot size={12} /> : <MessageSquare size={12} />}
                    <span>{message.role === "assistant" ? "Assistant" : "User"}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm leading-6">
                    {message.content || (message.role === "assistant" ? "..." : "")}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <DesktopComposer disabled={!currentConversation} onSubmit={handleSubmit} />
    </div>
  );
}
