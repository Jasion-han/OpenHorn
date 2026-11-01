import { describe, expect, test } from "bun:test";
import { createChatAdapter } from "../lib/chatAdapter";
import { groupMessagesByRound } from "../lib/messageGroups";
import type { Conversation, Message } from "../types/chat";
import { createDesktopChatStore } from "./chatStore";

const conversation: Conversation = {
  id: "render-identity-conversation",
  title: "HTML lifecycle",
  contextLength: 4096,
  defaultMode: "chat",
  lastMode: "chat",
  isPinned: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function draftMessages(): Message[] {
  return ["user", "assistant"].map((role) => ({
    id: `draft-render-${role}`,
    conversationId: conversation.id,
    role: role as Message["role"],
    content: role === "user" ? "Prompt" : "Live reply",
    mode: "chat",
    createdAt: new Date(0),
  }));
}

function setup() {
  let saved: Message[] = [];
  const store = createDesktopChatStore({
    ...createChatAdapter(),
    loadMessages: async () => saved,
  });
  store.setState({
    conversations: [conversation],
    currentConversation: conversation,
    messages: draftMessages(),
  });
  const key = () => groupMessagesByRound(store.getState().messages)[0]?.key;
  const reconcile = () =>
    store.getState().reconcileSidecarMessageIds({
      conversationId: conversation.id,
      assistantDraftId: "draft-render-assistant",
      userMessageId: "saved-render-user",
      assistantMessageId: "saved-render-assistant",
    });
  const serverSnapshot = () => {
    saved = store.getState().messages.map(({ renderKey: _renderKey, ...message }) => ({
      ...message,
      content: `Server ${message.role}`,
    }));
  };
  return { store, key, reconcile, serverSnapshot };
}

describe("mounted message identity", () => {
  test("reconciling both IDs keeps the round mounted and preserves message fields", () => {
    const { store, key, reconcile } = setup();
    const originalKey = key();
    reconcile();
    expect(key()).toBe(originalKey);
    expect(store.getState().messages.map((message) => message.id)).toEqual([
      "saved-render-user",
      "saved-render-assistant",
    ]);
    expect(store.getState().messages[1]).toMatchObject({
      content: "Live reply",
      renderKey: "draft-render-assistant",
    });
    reconcile();
    expect(key()).toBe(originalKey);
  });

  test("a server refresh keeps local keys while accepting authoritative content", async () => {
    const { store, key, reconcile, serverSnapshot } = setup();
    const originalKey = key();
    reconcile();
    serverSnapshot();
    await store.getState().loadMessages(conversation.id);
    expect(key()).toBe(originalKey);
    expect(store.getState().messages[1]?.content).toBe("Server assistant");
    await store.getState().selectConversation(conversation.id);
    expect(key()).toBe(originalKey);
    expect(store.getState().messages[1]?.content).toBe("Server assistant");
  });

  test("background reconciliation and cache reload keep the original identity", async () => {
    const { store, key, reconcile, serverSnapshot } = setup();
    const originalKey = key();
    // Selecting an unknown conversation parks the live messages in the cache.
    await store.getState().selectConversation("other-conversation");
    reconcile();
    const assistant = store.getState().findMessageAnywhere("saved-render-assistant");
    const user = store.getState().findMessageAnywhere("saved-render-user");
    expect(assistant?.renderKey).toBe("draft-render-assistant");
    if (!user || !assistant) throw new Error("Reconciled cache must retain both messages");
    store.setState({ messages: [user, assistant] });
    serverSnapshot();
    store.setState({ messages: [] });
    await store.getState().selectConversation(conversation.id);
    expect(key()).toBe(originalKey);
  });

  test("update, delta, and stream-done ID changes retain the first mounted key", () => {
    const { store, key } = setup();
    const originalKey = key();
    store.getState().updateMessage("draft-render-assistant", { id: "render-first" });
    store.getState().appendMessageDelta("render-first", " tail", { id: "render-second" });
    store.getState().applyStreamEvent("render-second", { type: "done", messageId: "render-final" });
    expect(key()).toBe(originalKey);
    expect(store.getState().messages[1]).toMatchObject({
      id: "render-final",
      renderKey: "draft-render-assistant",
      content: "Live reply tail",
    });
  });
});
