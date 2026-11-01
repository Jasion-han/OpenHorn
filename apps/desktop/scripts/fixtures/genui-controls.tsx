import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MessageBubble } from "../../src/components/chat/DesktopMessageBubble";
import { BarLineChart } from "../../src/components/chat/genui/charts";
import { genUiLibrary } from "../../src/components/chat/genui/library";
import { createChatAdapter } from "../../src/lib/chatAdapter";
import { blockStateKey, loadBlockState } from "../../src/lib/genui/blockState";
import { groupMessagesByRound } from "../../src/lib/messageGroups";
import { createDesktopChatStore } from "../../src/stores/chatStore";
import { useGenUiStore } from "../../src/stores/genUiStore";
import { usePreviewPanelStore } from "../../src/stores/previewPanelStore";
import type { Message } from "../../src/types/chat";

const catalog = [
  "root=Col([",
  'Title("Control catalog","xl"),',
  'Row([Badge("Ready","success"),Icon("check-circle","md","info"),Spacer(),Caption("Footnote")],2,"center","between",true),',
  'Card([Title("Panel","sm"),Text("Paragraph","sm","muted","medium",true),Divider(),Grid([Stat("Total",$amount,"Computed","info"),Progress($range,100,"Progress"),List(["Scalar",Badge("Nested","info")]),List(["First","Second"],true)],2,180,2)],"soft",2),',
  'Input($text,"Text","text","Enter text"),Input($amount,"Amount","number"),Slider($range,0,100,0.5,"Range","%"),',
  'Select($selected,$options,"Choice"),SegmentedControl($view,["Summary","Details"],"View"),Checkbox($checked,"Accepted",true),',
  'Row([Button("Set amount",@Set($amount,42),"ghost","refresh-cw"),Button("Reset",@Reset($amount,$text,$range,$selected,$view,$checked),"outline"),Button("Disabled",@Set($amount,999),"solid","x",true)],2,"center","start",true),',
  'Row([Button("Follow up",@ToAssistant("Explain values",{amount:$amount,accepted:$checked})),Button("Copy",@CopyToClipboard(@Join([$text,$selected],":"))),Button("Link",@OpenUrl("https://example.com/catalog")),Button("Offer label")],2,"center","start",true),',
  'Text($view == "Details" ? "Detailed view" : "Summary view"),',
  'Table(["Name","Value","Status"],[["Alpha",10,Badge("Good","success")],["Beta","20%",true]]),',
  'Chart("bar",["First","Second"],[{name:"Bar A",values:[$range,-10]},{name:"Bar B",values:[0,$amount]}],"元",180),',
  'Chart("line",["First","Second"],[{name:"Line A",values:[-5,$range]},{name:"Line B",values:[0,$amount]}],"%",160),',
  'Chart("pie",["First","Second"],[{name:"Share",values:[$range,10]}],"元")',
  "])",
  '$text="Initial"',
  "$amount=10",
  "$range=5",
  '$selected="Alpha"',
  '$options=["Alpha",{value:"Beta",label:"Option Beta"}]',
  '$view="Summary"',
  "$checked=false",
].join("\n");

const root = createRoot(document.getElementById("root") as HTMLElement);
let saved: Message[] = [];
const store = createDesktopChatStore({ ...createChatAdapter(), loadMessages: async () => saved });
let source = catalog;
let namespace = "controls";
let mode: "chat" | "agent" = "chat";
const markdown = (program: string, closed = true) =>
  `\`\`\`openui-lang\n${program}\n${closed ? "```\n\nAnswer tail." : ""}`;

function BubbleTree() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return groupMessagesByRound(state.messages).map((group) => (
    <div key={group.key}>
      {group.assistant ? (
        <MessageBubble
          message={group.assistant.msg}
          isStreaming={state.isStreaming}
          canEdit={false}
          canRetry={false}
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

function update(content: string, streaming: boolean) {
  const message = store.getState().messages[1];
  flushSync(() => {
    store.getState().updateMessage(message.id, {
      content,
      ...(mode === "agent"
        ? {
            agentRun: {
              status: streaming ? "running" : "completed",
              steps: [{ type: "text", content }],
            },
          }
        : {}),
    });
    store.setState({ isStreaming: streaming });
  });
}

const api = {
  catalog,
  inventory: Object.keys(genUiLibrary.components),
  actions: Object.keys(genUiLibrary.actions ?? {}),
  denseChart(count: number) {
    try {
      // Evaluate the real chart without attaching a huge synthetic DOM.
      BarLineChart({
        kind: "bar",
        labels: Array.from({ length: count }, (_, index) => String(index)),
        series: [{ name: "Dense", values: Array.from({ length: count }, (_, index) => index) }],
        height: 220,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  start(nextMode: "chat" | "agent", program = catalog, scope = "controls") {
    flushSync(() => root.render(null));
    mode = nextMode;
    source = program;
    namespace = scope;
    const content = markdown(program);
    const conversation = {
      id: `${scope}-conversation`,
      title: "Control matrix",
      contextLength: 4096,
      defaultMode: mode,
      lastMode: mode,
      isPinned: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    store.setState({
      conversations: [conversation],
      currentConversation: conversation,
      isStreaming: false,
      messages: [
        {
          id: `draft-${scope}-user`,
          conversationId: conversation.id,
          role: "user",
          content: "Control matrix",
          mode,
          createdAt: new Date(0),
        },
        {
          id: `draft-${scope}-assistant`,
          conversationId: conversation.id,
          role: "assistant",
          content,
          mode,
          createdAt: new Date(0),
          ...(mode === "agent"
            ? { agentRun: { status: "completed", steps: [{ type: "text", content }] } }
            : {}),
        },
      ],
    });
    useGenUiStore.setState({ composerRequest: null });
    usePreviewPanelStore.getState().closePanel();
    flushSync(() => root.render(<BubbleTree />));
  },
  incomplete: () => update(markdown(source, false), true),
  finish: () => update(markdown(source), false),
  replaceProgram(program: string) {
    source = program;
    update(markdown(source), false);
  },
  stop: () => flushSync(() => store.getState().abortStreaming()),
  reconcile() {
    flushSync(() =>
      store.getState().reconcileSidecarMessageIds({
        conversationId: `${namespace}-conversation`,
        assistantDraftId: `draft-${namespace}-assistant`,
        userMessageId: `saved-${namespace}-user`,
        assistantMessageId: `saved-${namespace}-assistant`,
      }),
    );
  },
  async reload() {
    saved = store.getState().messages.map(({ renderKey: _key, ...message }) => message);
    await store.getState().loadMessages(`${namespace}-conversation`);
  },
  remount() {
    flushSync(() => root.render(null));
    flushSync(() => root.render(<BubbleTree />));
  },
  state(fromDisk = false) {
    const message = store.getState().messages[1];
    const scope = mode === "agent" ? `${message.id}:0` : message.id;
    // A fresh storage identity skips the memory cache, so rejected programs can
    // prove that neither memory nor the debounced disk snapshot was polluted.
    const storage = fromDisk
      ? {
          getItem: (key: string) => localStorage.getItem(key),
          setItem: (key: string, value: string) => localStorage.setItem(key, value),
          removeItem: (key: string) => localStorage.removeItem(key),
        }
      : undefined;
    return loadBlockState(blockStateKey(scope, 0, source), storage);
  },
  snapshot: () => ({
    request: useGenUiStore.getState().composerRequest,
    tabs: usePreviewPanelStore.getState().tabs,
  }),
};

Object.assign(window, { genUiControls: api });
