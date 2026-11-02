import { describe, expect, test } from "bun:test";
import { createDesktopChatStore } from "../stores/chatStore";
import type { Conversation, Message } from "../types/chat";
import type { ChatAdapter } from "./chatAdapter";
import { getChatLabel } from "./i18n/agent";
import { createSidecarPersistence } from "./sidecarPersistence";

type Payload = Parameters<ReturnType<typeof createSidecarPersistence>["save"]>[1];
type Result = { userMessageId: string; assistantMessageId: string };
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required test value is missing");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const date = new Date("2026-11-02T00:00:00Z");
function message(
  id: string,
  role: Message["role"],
  content: string,
  conversationId = "conv-0",
): Message {
  return {
    id,
    role,
    content,
    conversationId,
    mode: "agent",
    createdAt: date,
    ...(role === "assistant"
      ? {
          agentRun: {
            status: "completed",
            summary: "",
            steps: [{ type: "text", content }],
          } as const,
        }
      : {}),
  };
}
function fixture(rows: Message[] = []) {
  const database = new Map<string, Message[]>([["conv-0", rows]]);
  const conversations: Conversation[] = Array.from({ length: 26 }, (_, i) => ({
    id: `conv-${i}`,
    title: `conversation ${i}`,
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: false,
    createdAt: date,
    updatedAt: date,
  }));
  const adapter: ChatAdapter = {
    listChannels: async () => [],
    listConversations: async () => conversations,
    createConversation: async () => conversations[0],
    updateConversation: async () => {},
    deleteConversation: async (id) => {
      database.delete(id);
    },
    autoTitleConversation: async () => ({ success: false }),
    loadMessages: async (id) =>
      database.get(id) ?? [message(`filler-${id}`, "assistant", "filler", id)],
    sendMessage: async () => {
      throw new Error("Generation must not run when saving");
    },
    deleteMessage: async (id) => {
      for (const [key, rows] of database)
        database.set(
          key,
          rows.filter((m) => m.id !== id),
        );
    },
    regenerateMessage: async () => {
      throw new Error("Generation must not run when saving");
    },
    editUserMessage: async () => {
      throw new Error("Generation must not run when saving");
    },
    searchMessages: async () => [],
    abortActiveStream: () => {},
    getSettings: async () => ({}),
  };
  const store = createDesktopChatStore(adapter);
  store.setState({ conversations, currentConversation: conversations[0], messages: rows });
  const notifications = new Map<string, () => Promise<void>>();
  const calls: Payload[] = [];
  let sync: (payload: Payload) => Promise<Result> = async () => {
    throw new Error("offline");
  };
  const persistence = createSidecarPersistence({
    store,
    sync: async (payload) => {
      calls.push(structuredClone(payload));
      return sync(payload);
    },
    failed: (id, retry) => {
      notifications.set(id, retry);
    },
    saved: (id) => {
      notifications.delete(id);
    },
  });
  const addTurn = (userId = "temp-user", assistantId = "temp-assistant") => {
    store.setState({
      messages: [message(userId, "user", "question"), message(assistantId, "assistant", "answer")],
    });
    return { userId, assistantId };
  };
  const payload: Payload = {
    conversationId: "conv-0",
    userContent: "question",
    assistantContent: "answer",
    model: "fixture",
    agentRun: { status: "completed", summary: "", steps: [{ type: "text", content: "answer" }] },
  };
  return {
    store,
    database,
    adapter,
    persistence,
    calls,
    notifications,
    addTurn,
    payload,
    setSync: (fn: typeof sync) => {
      sync = fn;
    },
  };
}
function ids(payload: Payload): Result {
  return {
    userMessageId: required(payload.userMessageId),
    assistantMessageId: required(payload.assistantMessageId ?? payload.newAssistantMessageId),
  };
}
async function evictAndReturn(f: ReturnType<typeof fixture>) {
  f.store.getState().setStreaming(false);
  for (let i = 1; i < 26; i++) await f.store.getState().selectConversation(`conv-${i}`);
  await f.store.getState().selectConversation("conv-0");
}

describe("Agent result saving is independent from generation", () => {
  test("fresh streaming drafts reach HTTP, preserve rendering, and retry only the immutable save", async () => {
    const f = fixture();
    f.addTurn();
    f.store.getState().setStreaming(true, "conv-0", "temp-assistant");
    f.store.getState().markMessagesActive(["temp-user", "temp-assistant"]);
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await save.completion;
    expect(f.calls).toHaveLength(1);
    expect(/^[a-f0-9-]{36}$/.test(save.assistantMessageId)).toBe(true);
    expect(f.store.getState().streamingMessageId).toBe(save.assistantMessageId);
    expect(f.store.getState().findMessageAnywhere(save.assistantMessageId)?.renderKey).toBe(
      "temp-assistant",
    );
    expect(f.store.getState().findMessageAnywhere(save.assistantMessageId)?.agentRun?.status).toBe(
      "completed",
    );
    expect(f.store.getState().findMessageAnywhere(save.assistantMessageId)?.content).toBe("answer");
    const retry = required(f.notifications.get(save.assistantMessageId));
    (f.payload.agentRun as { steps: Array<{ content: string }> }).steps[0].content =
      "mutated after save";
    const waiting = deferred<Result>();
    f.setSync(() => waiting.promise);
    const first = retry();
    const second = retry();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual(f.calls[0]);
    waiting.resolve(ids(f.calls[1]));
    await Promise.all([first, second]);
    expect(f.notifications.size).toBe(0);
    f.persistence.dispose();
  });

  test("failed fresh pairs survive nonempty LRU eviction in prompt-before-answer order", async () => {
    const f = fixture();
    f.addTurn();
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await save.completion;
    await evictAndReturn(f);
    expect(f.store.getState().messages.map((m) => [m.id, m.role, m.content])).toEqual([
      [save.userMessageId, "user", "question"],
      [save.assistantMessageId, "assistant", "answer"],
    ]);
    f.persistence.dispose();
  });

  test("failed persisted edits overlay stale database values after navigation", async () => {
    const f = fixture([
      message("opaque-user", "user", "old question"),
      message("opaque-assistant", "assistant", "old answer"),
    ]);
    f.addTurn("opaque-user", "opaque-assistant");
    await required(
      f.persistence.save(
        "opaque-assistant",
        { ...f.payload, userMessageId: "opaque-user", assistantMessageId: "opaque-assistant" },
        () => true,
      ),
    ).completion;
    await evictAndReturn(f);
    expect(f.store.getState().messages.map((m) => m.content)).toEqual(["question", "answer"]);
    f.persistence.dispose();
  });

  for (const deletedRole of ["user", "assistant"] as const) {
    test(`deleting an unsaved ${deletedRole} cancels pair retries and preserves only the other local message`, async () => {
      const f = fixture();
      f.addTurn();
      const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
      await save.completion;
      const retry = required(f.notifications.get(save.assistantMessageId));
      await f.store
        .getState()
        .deleteMessage(deletedRole === "user" ? save.userMessageId : save.assistantMessageId);
      await retry();
      await evictAndReturn(f);
      expect(f.calls).toHaveLength(1);
      expect(f.notifications.size).toBe(0);
      expect(f.store.getState().messages.map((m) => m.role)).toEqual([
        deletedRole === "user" ? "assistant" : "user",
      ]);
      f.persistence.dispose();
    });
  }

  test("ACK loss followed by deletion cannot recreate a committed reply", async () => {
    const f = fixture();
    f.addTurn();
    f.setSync(async (payload) => {
      const saved = ids(payload);
      f.database.set("conv-0", [
        message(saved.userMessageId, "user", "question"),
        message(saved.assistantMessageId, "assistant", "answer"),
      ]);
      throw new Error("ACK lost");
    });
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await save.completion;
    const retry = required(f.notifications.get(save.assistantMessageId));
    await f.store.getState().deleteMessage(save.assistantMessageId);
    await retry();
    await evictAndReturn(f);
    expect(f.calls).toHaveLength(1);
    expect(f.store.getState().messages.map((m) => m.role)).toEqual(["user"]);
    f.persistence.dispose();
  });

  test("deletion is gated during the HTTP save and becomes available after failure settles", async () => {
    const f = fixture();
    f.addTurn();
    const gate = deferred<Result>();
    f.setSync(() => gate.promise);
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    let rejection: unknown;
    try {
      await f.store.getState().deleteMessage(save.assistantMessageId);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.name : null).toBe("Error");
    expect(rejection instanceof Error ? rejection.message : null).toBe(
      getChatLabel("chat.save.inProgress"),
    );
    expect(f.store.getState().savingMessageIds.has(save.assistantMessageId)).toBe(true);
    gate.resolve({ userMessageId: "unexpected", assistantMessageId: "unexpected" });
    await save.completion;
    expect(f.store.getState().savingMessageIds.size).toBe(0);
    await f.store.getState().deleteMessage(save.assistantMessageId);
    expect(f.store.getState().messages.map((message) => message.role)).toEqual(["user"]);
    const retry = f.notifications.get(save.assistantMessageId);
    await retry?.();
    expect(f.calls).toHaveLength(1);
    f.persistence.dispose();
  });

  test("delete conversation and reset invalidate pending save actions", async () => {
    for (const action of ["delete", "reset"] as const) {
      const f = fixture();
      f.addTurn();
      const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
      await save.completion;
      const retry = required(f.notifications.get(save.assistantMessageId));
      if (action === "delete") await f.store.getState().deleteConversation("conv-0");
      else f.store.getState().reset();
      await retry();
      expect(f.calls).toHaveLength(1);
      expect(f.notifications.size).toBe(0);
      expect(f.persistence.save(save.assistantMessageId, f.payload, () => true)).toBe(null);
      f.persistence.dispose();
    }
  });

  test("late old ACK never releases a newer failed result", async () => {
    const f = fixture();
    f.addTurn();
    const oldAck = deferred<Result>();
    f.setSync(() => oldAck.promise);
    let oldOwns = true;
    const first = required(f.persistence.save("temp-assistant", f.payload, () => oldOwns));
    oldOwns = false;
    f.store.getState().markMessagesActive([first.assistantMessageId]);
    f.store.getState().updateMessage(first.assistantMessageId, {
      content: "new answer",
      agentRun: {
        status: "completed",
        summary: "",
        steps: [{ type: "text", content: "new answer" }],
      },
    });
    const newerAck = deferred<Result>();
    f.setSync(() => newerAck.promise);
    const second = required(
      f.persistence.save(
        first.assistantMessageId,
        {
          ...f.payload,
          userMessageId: first.userMessageId,
          assistantMessageId: first.assistantMessageId,
          assistantContent: "new answer",
          agentRun: { status: "completed", steps: [{ type: "text", content: "new answer" }] },
        },
        () => true,
      ),
    );
    oldAck.resolve(ids(f.calls[0]));
    await first.completion;
    expect(f.store.getState().savingMessageIds.has(second.assistantMessageId)).toBe(true);
    newerAck.resolve({ userMessageId: "unexpected", assistantMessageId: "unexpected" });
    await second.completion;
    expect(f.store.getState().savingMessageIds.size).toBe(0);
    f.store.getState().unmarkMessagesActive([first.assistantMessageId]);
    await evictAndReturn(f);
    expect(f.notifications.has(second.assistantMessageId)).toBe(true);
    expect(f.store.getState().messages[1].content).toBe("new answer");
    expect(
      required(f.calls[1].syncRevision).sequence > required(f.calls[0].syncRevision).sequence,
    ).toBe(true);
    f.persistence.dispose();
  });

  test("an old save defers during a replacement run and resumes after a zero-output restoration", async () => {
    const f = fixture();
    f.addTurn();
    let owns = true;
    const ack = deferred<Result>();
    f.setSync(() => ack.promise);
    const save = required(f.persistence.save("temp-assistant", f.payload, () => owns));
    owns = false;
    f.store.getState().markMessagesActive([save.assistantMessageId]);
    ack.resolve(ids(f.calls[0]));
    await save.completion;
    expect(f.calls).toHaveLength(1);
    f.setSync(async (payload) => ids(payload));
    f.store.getState().unmarkMessagesActive([save.assistantMessageId]);
    f.store.getState().updateMessage(save.assistantMessageId, { content: "answer" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual(f.calls[0]);
    expect(f.notifications.size).toBe(0);
    f.persistence.dispose();
  });

  test("stale reads that started before ACK reload after confirmed save", async () => {
    const f = fixture();
    f.addTurn();
    await f.store.getState().selectConversation("conv-1");
    const stale = deferred<Message[]>();
    let reads = 0;
    f.adapter.loadMessages = async (id) =>
      id === "conv-0" && ++reads === 1 ? stale.promise : (f.database.get(id) ?? []);
    const load = f.store.getState().selectConversation("conv-0");
    f.setSync(async (payload) => {
      const saved = ids(payload);
      f.database.set("conv-0", [
        message(saved.userMessageId, "user", "question"),
        message(saved.assistantMessageId, "assistant", "answer"),
      ]);
      return saved;
    });
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await save.completion;
    stale.resolve([]);
    await load;
    expect(reads).toBe(2);
    expect(f.store.getState().messages.map((m) => m.content)).toEqual(["question", "answer"]);
    f.persistence.dispose();
  });

  test("user-only edits use an explicit stable new assistant ID", async () => {
    const f = fixture();
    f.addTurn("imported-user", "temp-assistant");
    const save = required(
      f.persistence.save(
        "temp-assistant",
        { ...f.payload, userMessageId: "imported-user" },
        () => true,
      ),
    );
    await save.completion;
    expect(f.calls[0].userMessageId).toBe("imported-user");
    expect(f.calls[0].assistantMessageId).toBe(undefined);
    expect(f.calls[0].newAssistantMessageId).toBe(save.assistantMessageId);
    f.persistence.dispose();
  });
});
