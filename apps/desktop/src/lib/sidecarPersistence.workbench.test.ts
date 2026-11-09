import { expect, test } from "bun:test";
import { createDesktopChatStore } from "../stores/chatStore";
import type { Message } from "../types/chat";
import type { ChatAdapter } from "./chatAdapter";
import { createSidecarPersistence } from "./sidecarPersistence";

for (const succeeds of [true, false]) {
  test(`workbench task completion requires an acknowledged save: ${succeeds}`, async () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    const createdAt = new Date("2026-11-09T00:00:00Z");
    const messages: Message[] = [
      {
        id: "saved-user",
        conversationId: "task-conversation",
        role: "user",
        mode: "agent",
        content: "Review",
        createdAt,
      },
      {
        id: "saved-assistant",
        conversationId: "task-conversation",
        role: "assistant",
        mode: "agent",
        content: "Result",
        createdAt,
      },
    ];
    store.setState({ messages });
    const persistence = createSidecarPersistence({
      store,
      sync: async () => {
        if (!succeeds) throw new Error("Synthetic save failure");
        return { userMessageId: "saved-user", assistantMessageId: "saved-assistant" };
      },
      failed() {},
      saved() {},
    });
    try {
      const save = persistence.save(
        "saved-assistant",
        {
          conversationId: "task-conversation",
          userContent: "Review",
          assistantContent: "Result",
          userMessageId: "saved-user",
          assistantMessageId: "saved-assistant",
        },
        () => true,
      );
      if (!save) throw new Error("Expected a retained turn");
      expect(await save.completion).toBe(succeeds);
      expect(store.getState().isMessageUnsaved("saved-assistant")).toBe(!succeeds);
    } finally {
      persistence.dispose();
    }
  });
}
