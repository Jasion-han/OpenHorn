import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AgentRunPanel } from "../src/components/chat/DesktopAgentRunPanel";
import { DesktopMarkdownMessage } from "../src/components/chat/DesktopMarkdownMessage";
import { MessageBubble } from "../src/components/chat/DesktopMessageBubble";
import { DesktopStreamingMarkdownMessage } from "../src/components/chat/DesktopStreamingMarkdownMessage";
import { createChatAdapter } from "../src/lib/chatAdapter";
import { blockStateKey } from "../src/lib/genui/blockState";
import { groupMessagesByRound } from "../src/lib/messageGroups";
import { THEME_MODE_CHANGE_EVENT } from "../src/lib/theme";
import { createDesktopChatStore } from "../src/stores/chatStore";
import type { Message } from "../src/types/chat";

const node = document.getElementById("root");
if (!node) throw new Error("missing test root");
const root = createRoot(node);
let savedMessages: Message[] = [];
const store = createDesktopChatStore({
  ...createChatAdapter(),
  loadMessages: async () => savedMessages,
});
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

function BubbleState() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return groupMessagesByRound(state.messages).map((group) => (
    <div key={group.key}>
      {group.assistant ? (
        <MessageBubble
          message={group.assistant.msg}
          isStreaming={state.isStreaming}
          canEdit={false}
          canRetry={!state.isStreaming}
          canDelete={false}
          onEdit={() => {}}
          onRetry={() => {}}
          onDelete={() => {}}
          assistantWidth="100%"
          userMaxWidth="72%"
        />
      ) : null}
    </div>
  ));
}

const htmlProgram = `<button onclick="this.textContent='Clicked';window.localCount=(window.localCount||0)+1">Stream button</button>`;
const htmlMarkdown = (source = htmlProgram) =>
  `\`\`\`html-ui\n${source}\n\`\`\`\n\nContinuing answer...`;

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
  renderStable: (content: string, streaming: boolean) => {
    flushSync(() =>
      root.render(
        <DesktopStreamingMarkdownMessage content={content} pulseKey={0} streaming={streaming} />,
      ),
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
  startHtml: (agent = false) => {
    const content = htmlMarkdown();
    const mode = agent ? "agent" : "chat";
    store.setState({
      messages: [
        {
          id: "draft-html-user",
          conversationId: "html-conversation",
          role: "user",
          mode,
          content: "Test live HTML",
          createdAt: new Date(),
        },
        {
          id: "draft-html-assistant",
          conversationId: "html-conversation",
          role: "assistant",
          mode,
          content,
          createdAt: new Date(),
          ...(agent
            ? {
                agentRun: {
                  status: "running" as const,
                  steps: [{ type: "text" as const, content }],
                },
              }
            : {}),
        },
      ],
      isStreaming: true,
    });
    flushSync(() => root.render(<BubbleState />));
  },
  advanceHtmlAgent: () => {
    const message = store.getState().messages[1];
    if (!message.agentRun) throw new Error("Expected Agent HTML fixture");
    const steps = [
      ...message.agentRun.steps,
      { type: "text" as const, content: "A later text step is streaming." },
    ];
    flushSync(() =>
      store.getState().updateMessage(message.id, {
        agentRun: { ...message.agentRun, status: "running", steps },
      }),
    );
  },
  finishHtml: (reconcile = false) => {
    flushSync(() => {
      if (reconcile) {
        store.getState().reconcileSidecarMessageIds({
          conversationId: "html-conversation",
          assistantDraftId: "draft-html-assistant",
          userMessageId: "saved-html-user",
          assistantMessageId: "saved-html-assistant",
        });
      }
      const message = store.getState().messages[1];
      const content = `${htmlMarkdown()}\n\nDone.`;
      store.getState().updateMessage(message.id, {
        content,
        ...(message.agentRun
          ? {
              agentRun: {
                status: "completed",
                steps: message.agentRun.steps.map((step, index) =>
                  index === 0 ? { ...step, content } : step,
                ),
              },
            }
          : {}),
      });
      store.setState({ isStreaming: false });
    });
  },
  reloadHtml: async () => {
    savedMessages = store.getState().messages.map((message) => {
      const { renderKey: _renderKey, ...saved } = message;
      return saved;
    });
    store.setState({
      currentConversation: {
        id: "html-conversation",
        title: "HTML lifecycle",
        contextLength: 4096,
        defaultMode: "chat",
        lastMode: "chat",
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await store.getState().loadMessages("html-conversation");
  },
  replaceHtml: () => {
    const message = store.getState().messages[1];
    const content = htmlMarkdown(htmlProgram.replace("Stream button", "New program"));
    flushSync(() =>
      store.getState().updateMessage(message.id, {
        content,
        ...(message.agentRun
          ? { agentRun: { status: "completed", steps: [{ type: "text", content }] } }
          : {}),
      }),
    );
  },
};
Object.assign(window, { genUiStateTest: harness, genUiStateProgram: program });
