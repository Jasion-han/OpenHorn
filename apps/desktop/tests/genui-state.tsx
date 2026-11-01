import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AgentRunPanel } from "../src/components/chat/DesktopAgentRunPanel";
import { DesktopMarkdownMessage } from "../src/components/chat/DesktopMarkdownMessage";
import { DesktopStreamingMarkdownMessage } from "../src/components/chat/DesktopStreamingMarkdownMessage";
import { blockStateKey } from "../src/lib/genui/blockState";
import { THEME_MODE_CHANGE_EVENT } from "../src/lib/theme";
import { createDesktopChatStore } from "../src/stores/chatStore";
import type { Message } from "../src/types/chat";

const node = document.getElementById("root");
if (!node) throw new Error("missing test root");
const root = createRoot(node);
const store = createDesktopChatStore();
const program = 'root=Card([Button("change",@Set($x,42)),Stat("X",$x)])\n$x=1';
const markdown = (source: string) => `\`\`\`openui-lang\n${source}\n\`\`\`\n\nContinuing answer...`;

function AgentState() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const message = state.messages[0];
  return message ? (
    <AgentRunPanel
      key={message.id}
      run={message.agentRun}
      isStreaming={message.agentRun?.status === "running"}
      genUiScope={message.id}
    />
  ) : null;
}

const harness = {
  render: (source = program, streaming = false, scope = "reply") => {
    const content = markdown(source);
    flushSync(() =>
      root.render(
        streaming ? (
          <DesktopStreamingMarkdownMessage content={content} pulseKey={0} genUiScope={scope} />
        ) : (
          <DesktopMarkdownMessage content={content} genUiScope={scope} />
        ),
      ),
    );
  },
  renderRaw: (content: string, streaming: boolean) => {
    flushSync(() =>
      root.render(<DesktopMarkdownMessage content={content} streaming={streaming} />),
    );
  },
  theme: () => {
    document.documentElement.classList.toggle("dark");
    flushSync(() => window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT)));
  },
  startAgent: () => {
    const message: Message = {
      id: "temp-agent",
      conversationId: "conversation",
      role: "assistant",
      mode: "agent",
      content: markdown(program),
      createdAt: new Date(),
      agentRun: {
        status: "running",
        steps: [{ type: "text", content: markdown(program), timestamp: Date.now() }],
      },
    };
    store.setState({ messages: [message] });
    flushSync(() => root.render(<AgentState />));
  },
  finishAgent: () => {
    flushSync(() => {
      store.getState().reconcileSidecarMessageIds({
        conversationId: "conversation",
        assistantDraftId: "temp-agent",
        userMessageId: "saved-user",
        assistantMessageId: "saved-agent",
      });
      const message = store.getState().messages[0];
      store.getState().updateMessage(message.id, {
        agentRun: {
          ...message.agentRun,
          status: "completed",
          steps: message.agentRun?.steps ?? [],
        },
      });
    });
  },
  savedAgentState: () =>
    localStorage.getItem(`openhorn.genUi.state:${blockStateKey("saved-agent:0", 0, program)}`),
};
Object.assign(window, { genUiStateTest: harness, genUiStateProgram: program });
