import { describe, expect, test } from "bun:test";
import { createDesktopChatStore } from "../stores/chatStore";
import type { Conversation, Message } from "../types/chat";
import type { ChatAdapter } from "./chatAdapter";
import { getChatLabel } from "./i18n/agent";
import { SidecarSaveConflict } from "./serverApi";
import {
  type OutboxRecord,
  type SaveScope,
  type SidecarOutbox,
  sameSaveScope,
} from "./sidecarOutbox";
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
function fixture(
  rows: Message[] = [],
  durable?: { outbox: SidecarOutbox; scope: () => SaveScope | null },
) {
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
  const failureReasons: string[] = [];
  let recoveryFailures = 0;
  let sync: (payload: Payload) => Promise<Result> = async () => {
    throw new Error("offline");
  };
  const persistence = createSidecarPersistence({
    ...durable,
    store,
    sync: async (payload) => {
      calls.push(structuredClone(payload));
      return sync(payload);
    },
    failed: (id, retry, reason) => {
      notifications.set(id, retry);
      failureReasons.push(reason ?? "sync");
    },
    recoveryFailed: () => {
      recoveryFailures++;
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
    failureReasons,
    recoveryFailures: () => recoveryFailures,
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

function memoryOutbox() {
  const rows = new Map<string, OutboxRecord>();
  const recordKey = (record: OutboxRecord) => JSON.stringify([record.scope, record.assistant.id]);
  const outbox: SidecarOutbox = {
    async put(record) {
      rows.set(recordKey(record), structuredClone(record));
    },
    async list(scope) {
      return [...rows.values()]
        .filter((r) => sameSaveScope(r.scope, scope))
        .map((r) => structuredClone(r));
    },
    async remove(record) {
      const key = recordKey(record);
      if (
        JSON.stringify(rows.get(key)?.payload.syncRevision) ===
        JSON.stringify(record.payload.syncRevision)
      )
        rows.delete(key);
    },
    async clear(scope) {
      for (const [key, record] of rows) if (sameSaveScope(scope, record.scope)) rows.delete(key);
    },
    async invalidate(scope, filter) {
      for (const [key, record] of rows) {
        if (
          sameSaveScope(scope, record.scope) &&
          (!filter.conversationId || record.payload.conversationId === filter.conversationId) &&
          (!filter.messageId ||
            record.user.id === filter.messageId ||
            record.assistant.id === filter.messageId)
        )
          rows.delete(key);
      }
    },
  };
  return { rows, outbox };
}
const saveScope: SaveScope = { backend: "http://fixture.invalid", userId: "user-a" };

describe("durable Agent save recovery", () => {
  test("restart restores final snapshots and retries only the original stable save", async () => {
    const disk = memoryOutbox();
    const durable = { outbox: disk.outbox, scope: () => saveScope };
    const first = fixture([], durable);
    first.addTurn();
    const saved = required(first.persistence.save("temp-assistant", first.payload, () => true));
    expect(await saved.completion).toBe(false);
    const original = first.calls[0];
    expect(disk.rows.size).toBe(1);
    first.persistence.dispose();
    const restarted = fixture([], durable);
    restarted.setSync(async (payload) => ids(payload));
    await restarted.persistence.recover();
    expect(restarted.calls).toEqual([{ ...original, recovery: true }]);
    expect(restarted.store.getState().messages.map((m) => m.content)).toEqual([
      "question",
      "answer",
    ]);
    expect(restarted.store.getState().messages[1].agentRun?.status).toBe("completed");
    expect(disk.rows.size).toBe(0);
    restarted.persistence.dispose();
  });

  test("a lost ACK is replayed with the same original session and sequence", async () => {
    const disk = memoryOutbox();
    const durable = { outbox: disk.outbox, scope: () => saveScope };
    const first = fixture([], durable);
    first.addTurn();
    first.setSync(async () => {
      throw new Error("ACK lost after commit");
    });
    await required(first.persistence.save("temp-assistant", first.payload, () => true)).completion;
    const expected = structuredClone(first.calls[0]);
    first.persistence.dispose();
    const next = fixture([], durable);
    next.setSync(async (payload) => ids(payload));
    await next.persistence.recover();
    expect(next.calls[0]).toEqual({ ...expected, recovery: true });
    expect(next.calls).toHaveLength(1);
    next.persistence.dispose();
  });

  test("other users and backends never see or send this scope's saves", async () => {
    const disk = memoryOutbox();
    const first = fixture([], { outbox: disk.outbox, scope: () => saveScope });
    first.addTurn();
    await required(first.persistence.save("temp-assistant", first.payload, () => true)).completion;
    first.persistence.dispose();
    for (const scope of [
      { ...saveScope, userId: "user-b" },
      { ...saveScope, backend: "http://other.invalid" },
    ]) {
      const other = fixture([], { outbox: disk.outbox, scope: () => scope });
      await other.persistence.recover();
      expect(other.calls).toHaveLength(0);
      expect(other.store.getState().messages).toHaveLength(0);
      other.persistence.dispose();
    }
    expect(disk.rows.size).toBe(1);
  });

  test("deleting a retained message clears its pair from disk before the next recovery", async () => {
    const disk = memoryOutbox();
    const durable = { outbox: disk.outbox, scope: () => saveScope };
    const first = fixture([], durable);
    first.addTurn();
    const saved = required(first.persistence.save("temp-assistant", first.payload, () => true));
    await saved.completion;
    await first.store.getState().deleteMessage(saved.assistantMessageId);
    expect(disk.rows.size).toBe(0);
    first.persistence.dispose();
    const next = fixture([], durable);
    await next.persistence.recover();
    expect(next.calls).toHaveLength(0);
    next.persistence.dispose();
  });

  test("logout clears the old scope and fences an in-flight ACK", async () => {
    const disk = memoryOutbox();
    let scope: SaveScope | null = saveScope;
    const f = fixture([], { outbox: disk.outbox, scope: () => scope });
    f.addTurn();
    const gate = deferred<Result>();
    f.setSync(() => gate.promise);
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await Promise.resolve();
    await Promise.resolve();
    scope = null;
    await f.persistence.forgetScope(saveScope);
    gate.resolve(ids(f.calls[0]));
    expect(await save.completion).toBe(false);
    expect(disk.rows.size).toBe(0);
    f.persistence.dispose();
  });

  test("local storage failure still permits an online save and reports when both fail", async () => {
    const disk = memoryOutbox();
    disk.outbox.put = async () => {
      throw new Error("quota exceeded");
    };
    const f = fixture([], { outbox: disk.outbox, scope: () => saveScope });
    f.addTurn();
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    expect(await save.completion).toBe(false);
    expect(f.failureReasons).toEqual(["storage"]);
    f.setSync(async (payload) => ids(payload));
    await required(f.notifications.get(save.assistantMessageId))();
    expect(f.notifications.size).toBe(0);
    expect(f.store.getState().messages[1].content).toBe("answer");
    f.persistence.dispose();
  });

  test("corrupted records remain on disk and recovery reports the problem", async () => {
    const disk = memoryOutbox();
    disk.outbox.list = async () => [{ version: 99 } as unknown as OutboxRecord];
    const f = fixture([], { outbox: disk.outbox, scope: () => saveScope });
    await f.persistence.recover();
    expect(f.recoveryFailures()).toBe(1);
    expect(f.calls).toHaveLength(0);
    f.persistence.dispose();
  });

  test("a running replacement is never overwritten by a recovered snapshot", async () => {
    const disk = memoryOutbox();
    const durable = { outbox: disk.outbox, scope: () => saveScope };
    const first = fixture([], durable);
    first.addTurn();
    const save = required(first.persistence.save("temp-assistant", first.payload, () => true));
    await save.completion;
    first.persistence.dispose();
    const second = fixture(
      [
        message(save.userMessageId, "user", "new"),
        message(save.assistantMessageId, "assistant", "new"),
      ],
      durable,
    );
    second.store.getState().markMessagesActive([save.assistantMessageId]);
    await second.persistence.recover();
    expect(second.calls).toHaveLength(0);
    expect(second.store.getState().messages[1].content).toBe("new");
    second.persistence.dispose();
  });
});

describe("save recovery invalidation races", () => {
  for (const action of ["message", "conversation", "reset"] as const) {
    test(`a delayed disk snapshot cannot resurrect a ${action} deletion`, async () => {
      const disk = memoryOutbox();
      const durable = { outbox: disk.outbox, scope: () => saveScope };
      const first = fixture([], durable);
      first.addTurn();
      const save = required(first.persistence.save("temp-assistant", first.payload, () => true));
      await save.completion;
      const snapshot = await disk.outbox.list(saveScope);
      first.persistence.dispose();
      const gate = deferred<OutboxRecord[]>();
      disk.outbox.list = () => gate.promise;
      const next = fixture([], durable);
      const recovery = next.persistence.recover();
      if (action === "message") await next.store.getState().deleteMessage(save.assistantMessageId);
      else if (action === "conversation") await next.store.getState().deleteConversation("conv-0");
      else await next.store.getState().reset();
      gate.resolve(snapshot);
      await recovery;
      expect(next.calls).toHaveLength(0);
      expect(next.store.getState().messages).toHaveLength(0);
      expect(disk.rows.size).toBe(0);
      next.persistence.dispose();
    });
  }

  test("explicit deletion awaits the durable invalidation commit", async () => {
    const disk = memoryOutbox();
    const gate = deferred<void>();
    const original = disk.outbox.invalidate;
    disk.outbox.invalidate = async (scope, filter) => {
      await gate.promise;
      await original(scope, filter);
    };
    const f = fixture([], { outbox: disk.outbox, scope: () => saveScope });
    f.addTurn();
    const save = required(f.persistence.save("temp-assistant", f.payload, () => true));
    await save.completion;
    let deleted = false;
    const deletion = f.store
      .getState()
      .deleteMessage(save.assistantMessageId)
      .then(() => {
        deleted = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(deleted).toBe(false);
    gate.resolve();
    await deletion;
    expect(deleted).toBe(true);
    f.persistence.dispose();
  });

  test("a replayed ACK refreshes server truth instead of preserving an obsolete snapshot", async () => {
    const disk = memoryOutbox();
    const durable = { outbox: disk.outbox, scope: () => saveScope };
    const first = fixture([], durable);
    first.addTurn();
    const save = required(first.persistence.save("temp-assistant", first.payload, () => true));
    await save.completion;
    first.persistence.dispose();
    const next = fixture([], durable);
    next.database.set("conv-0", [
      message(save.userMessageId, "user", "question"),
      message(save.assistantMessageId, "assistant", "newer session answer"),
    ]);
    next.setSync(async (payload) => ({ ...ids(payload), replayed: true }));
    await next.persistence.recover();
    expect(next.store.getState().messages[1].content).toBe("newer session answer");
    next.persistence.dispose();
  });
});

test("switching identity clears the previous scope without deleting the next user's outbox", async () => {
  const disk = memoryOutbox();
  const scopeB = { ...saveScope, userId: "user-b" };
  const b = fixture([], { outbox: disk.outbox, scope: () => scopeB });
  b.addTurn();
  await required(
    b.persistence.save(
      "temp-assistant",
      { ...b.payload, assistantContent: "B result" },
      () => true,
    ),
  ).completion;
  b.persistence.dispose();
  let scope: SaveScope | null = saveScope;
  const a = fixture([], { outbox: disk.outbox, scope: () => scope });
  a.addTurn();
  await required(a.persistence.save("temp-assistant", a.payload, () => true)).completion;
  expect(disk.rows.size).toBe(2);
  scope = scopeB;
  const clearPrevious = a.persistence.forgetScope(saveScope);
  await a.store.getState().reset({ preserveSaveOutbox: true });
  await clearPrevious;
  expect((await disk.outbox.list(scopeB)).length).toBe(1);
  expect((await disk.outbox.list(saveScope)).length).toBe(0);
  a.store.setState({
    conversations: b.store.getState().conversations,
    currentConversation: b.store.getState().currentConversation,
  });
  a.setSync(async (payload) => ids(payload));
  await a.persistence.recover();
  expect(a.calls).toHaveLength(2);
  expect(a.calls[1].assistantContent).toBe("B result");
  expect(disk.rows.size).toBe(0);
  a.persistence.dispose();
});

test("conflicting restarted saves preserve local content until an explicit discard reloads server truth", async () => {
  const disk = memoryOutbox();
  const durable = { outbox: disk.outbox, scope: () => saveScope };
  const first = fixture([], durable);
  first.addTurn();
  const save = required(first.persistence.save("temp-assistant", first.payload, () => true));
  await save.completion;
  first.persistence.dispose();
  const next = fixture([], durable);
  next.database.set("conv-0", [
    message(save.userMessageId, "user", "remote question"),
    message(save.assistantMessageId, "assistant", "remote result"),
  ]);
  next.setSync(async () => {
    throw new SidecarSaveConflict();
  });
  await next.persistence.recover();
  expect(next.failureReasons).toEqual(["conflict"]);
  expect(next.store.getState().messages[1].content).toBe("answer");
  expect(disk.rows.size).toBe(1);
  await next.persistence.discard(save.assistantMessageId);
  expect(disk.rows.size).toBe(0);
  expect(next.store.getState().messages[1].content).toBe("remote result");
  next.persistence.dispose();
});

test("a confirmed save carries the new compare-and-swap tokens into the next edit", async () => {
  const f = fixture();
  f.addTurn();
  f.setSync(async (payload) => ({
    ...ids(payload),
    saveTokens: { user: "a".repeat(64), assistant: "b".repeat(64) },
  }));
  const first = required(f.persistence.save("temp-assistant", f.payload, () => true));
  expect(await first.completion).toBe(true);
  f.setSync(async () => {
    throw new Error("offline next edit");
  });
  f.store.getState().updateMessage(first.assistantMessageId, { content: "edited" });
  const second = required(
    f.persistence.save(
      first.assistantMessageId,
      {
        ...f.payload,
        userMessageId: first.userMessageId,
        assistantMessageId: first.assistantMessageId,
      },
      () => true,
    ),
  );
  await second.completion;
  expect(f.calls[1].expectedUserToken).toBe("a".repeat(64));
  expect(f.calls[1].expectedAssistantToken).toBe("b".repeat(64));
  f.persistence.dispose();
});
