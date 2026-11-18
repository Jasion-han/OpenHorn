import { expect, test } from "bun:test";
import type { ChatAdapter } from "../lib/chatAdapter";
import type { Conversation } from "../types/chat";
import { createDesktopChatStore } from "./chatStore";

const original: Conversation = {
  id: "metadata-race",
  title: "Original",
  projectId: null,
  contextLength: 4096,
  defaultMode: "agent",
  lastMode: "agent",
  isPinned: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("delayed auto-title response cannot replace a manual title in the list or selected chat", async () => {
  const response = deferred<{ success: boolean; title: string }>();
  const adapter = {
    autoTitleConversation: () => response.promise,
    updateConversation: async () => {},
  } as unknown as ChatAdapter;
  const store = createDesktopChatStore(adapter);
  const chat = { ...original, title: "新会话" };
  store.setState({ conversations: [chat], currentConversation: chat });
  const pending = store.getState().autoTitleConversation(chat.id, "seed");
  await store.getState().updateConversation(chat.id, { title: "Manual" });
  response.resolve({ success: true, title: "Automatic" });
  expect((await pending).success).toBe(false);
  expect(store.getState().currentConversation?.title).toBe("Manual");
  expect(store.getState().conversations[0]?.title).toBe("Manual");
});

test("native refusal clears streamed text and citations while preserving structured process metadata", () => {
  const store = createDesktopChatStore({} as ChatAdapter);
  store.setState({
    messages: [
      {
        id: "native-reply",
        conversationId: original.id,
        role: "assistant",
        mode: "chat",
        content: "partial answer",
        citations: [{ title: "Source", url: "https://example.com/" }],
        createdAt: new Date(),
      },
    ],
  });
  const metadata = {
    refused: true,
    citations: [],
    steps: [{ id: "search", action: "search", status: "completed" }],
  };
  store.getState().applyStreamEvent("native-reply", { type: "chat_metadata", metadata });
  expect(store.getState().messages[0].content).toBe("");
  expect(store.getState().messages[0].citations).toEqual([]);
  expect(store.getState().messages[0].finishReason).toBe("refused");
  expect(store.getState().messages[0].nativeMetadata?.steps).toEqual(metadata.steps);
});

test("failed rename cannot roll back a successful project move", async () => {
  const rename = deferred<void>();
  const store = createDesktopChatStore({
    updateConversation: async (_id, data) => {
      if (data.title) await rename.promise;
    },
  } as ChatAdapter);
  store.setState({ conversations: [original], currentConversation: original });
  const first = store
    .getState()
    .updateConversation(original.id, { title: "Pending rename" })
    .catch(() => {});
  const second = store.getState().updateConversation(original.id, { projectId: "new-project" });
  rename.reject(new Error("Synthetic rename failure"));
  await Promise.all([first, second]);
  expect(store.getState().currentConversation?.title).toBe("Original");
  expect(store.getState().currentConversation?.projectId).toBe("new-project");
});

test("two failed edits of one field restore the original committed value", async () => {
  const first = deferred<void>(),
    second = deferred<void>();
  const store = createDesktopChatStore({
    updateConversation: async (_id, data) => {
      await (data.title === "First" ? first : second).promise;
    },
  } as ChatAdapter);
  store.setState({ conversations: [original], currentConversation: original });
  const a = store
    .getState()
    .updateConversation(original.id, { title: "First" })
    .catch(() => {});
  const b = store
    .getState()
    .updateConversation(original.id, { title: "Second" })
    .catch(() => {});
  first.reject(new Error("first failed"));
  await a;
  second.reject(new Error("second failed"));
  await b;
  expect(store.getState().currentConversation?.title).toBe("Original");
});

test("a delayed metadata refresh cannot erase an accepted rename", async () => {
  const refresh = deferred<Conversation[]>();
  const store = createDesktopChatStore({
    listConversations: () => refresh.promise,
    updateConversation: async () => {},
  } as unknown as ChatAdapter);
  store.setState({ conversations: [original], currentConversation: original });
  const loading = store.getState().loadConversations();
  await store.getState().updateConversation(original.id, { title: "Accepted title" });
  refresh.resolve([original]);
  await loading;
  expect(store.getState().currentConversation?.title).toBe("Accepted title");
});

test("metadata rollback preserves a newer title set by the runtime", async () => {
  const request = deferred<void>();
  const store = createDesktopChatStore({
    updateConversation: () => request.promise,
  } as unknown as ChatAdapter);
  store.setState({ conversations: [original], currentConversation: original });
  const pending = store
    .getState()
    .updateConversation(original.id, { isPinned: true })
    .catch(() => {});
  const newer = { ...store.getState().conversations[0], title: "Runtime title" };
  store.setState({ conversations: [newer], currentConversation: newer });
  request.reject(new Error("pin failed"));
  await pending;
  expect(store.getState().currentConversation?.title).toBe("Runtime title");
  expect(store.getState().currentConversation?.isPinned).toBe(false);
});

test("reset cancels queued metadata writes before they can reach a different session", async () => {
  const request = deferred<void>();
  let calls = 0;
  const store = createDesktopChatStore({
    updateConversation: async () => {
      calls++;
      await request.promise;
    },
  } as unknown as ChatAdapter);
  store.setState({ conversations: [original], currentConversation: original });
  const first = store
    .getState()
    .updateConversation(original.id, { title: "First" })
    .catch(() => {});
  const queued = store
    .getState()
    .updateConversation(original.id, { title: "Queued" })
    .catch(() => {});
  await store.getState().reset();
  request.resolve();
  await Promise.all([first, queued]);
  expect(calls).toBe(1);
  expect(store.getState().conversations).toEqual([]);
});

test("a newer background refresh settles a superseded foreground loading indicator", async () => {
  const first = deferred<Conversation[]>(),
    second = deferred<Conversation[]>();
  let calls = 0;
  const store = createDesktopChatStore({
    listConversations: () => (++calls === 1 ? first : second).promise,
  } as unknown as ChatAdapter);
  const a = store.getState().loadConversations();
  const b = store.getState().loadConversations({ background: true });
  second.resolve([{ ...original, title: "Newer list" }]);
  await b;
  expect(store.getState().isLoading).toBe(false);
  first.resolve([original]);
  await a;
  expect(store.getState().conversations[0].title).toBe("Newer list");
});
