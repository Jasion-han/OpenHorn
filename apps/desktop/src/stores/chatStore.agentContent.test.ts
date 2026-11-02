import { describe, expect, test } from "bun:test";
import type { ChatAdapter } from "../lib/chatAdapter";
import type { Conversation, Message } from "../types/chat";
import { createDesktopChatStore } from "./chatStore";

/**
 * Agent replies stream into agentRun text steps; `content` must always mirror
 * them so every reader of `content` (history, copy, search, export) sees the
 * answer. These cover each store path that changes an agent run.
 */

function conversation(id: string): Conversation {
  return {
    id,
    title: id,
    channelId: "channel-1",
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: false,
    createdAt: new Date("2026-10-31T10:00:00.000Z"),
    updatedAt: new Date("2026-10-31T10:00:00.000Z"),
  };
}

function createAdapter(): ChatAdapter {
  return {
    listChannels: async () => [],
    listConversations: async () => [conversation("conv-a"), conversation("conv-b")],
    createConversation: async () => conversation("conv-new"),
    updateConversation: async () => {},
    deleteConversation: async () => {},
    autoTitleConversation: async () => ({ success: false }),
    loadMessages: async () => [],
    sendMessage: async () => new Response("ok", { status: 200 }),
    deleteMessage: async () => {},
    regenerateMessage: async () => new Response("ok", { status: 200 }),
    editUserMessage: async () => new Response("ok", { status: 200 }),
    searchMessages: async () => [],
    abortActiveStream: () => {},
    getSettings: async () => ({}),
  };
}

function agentDraft(id: string, conversationId: string): Message {
  return {
    id,
    conversationId,
    role: "assistant",
    content: "",
    mode: "agent",
    agentRun: { status: "partial", summary: "Thinking", steps: [] },
    createdAt: new Date("2026-10-31T10:01:00.000Z"),
  };
}

async function setup() {
  const store = createDesktopChatStore(createAdapter());
  await store.getState().loadConversations();
  await store.getState().selectConversation("conv-a");
  store.getState().addMessage(agentDraft("draft-assistant-1", "conv-a"));
  const get = () => store.getState().findMessageAnywhere("draft-assistant-1");
  return { store, get };
}

describe("agent reply content invariant", () => {
  test("deltas land in text steps and in content", async () => {
    const { store, get } = await setup();
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "蓝鲸" });
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "42" });

    expect(get()?.content).toBe("蓝鲸42");
    expect(get()?.agentRun?.steps).toHaveLength(1);
  });

  test("text separated by a tool call joins with a blank line", async () => {
    const { store, get } = await setup();
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "before" });
    store.getState().applyStreamEvent("draft-assistant-1", {
      type: "agent_event",
      event: { type: "tool_start", toolName: "Bash", toolCallId: "t1" },
    });
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "after" });

    expect(get()?.content).toBe("before\n\nafter");
  });

  test("clear_streaming_text drops the cleared text from content; reasoning adds none", async () => {
    const { store, get } = await setup();
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "draft" });
    store.getState().applyStreamEvent("draft-assistant-1", { type: "clear_streaming_text" });
    expect(get()?.content).toBe("");

    store.getState().applyStreamEvent("draft-assistant-1", {
      type: "agent_event",
      event: { type: "reasoning", content: "let me think" },
    });
    expect(get()?.content).toBe("");

    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "final" });
    expect(get()?.content).toBe("final");
  });

  test("a failed agent run keeps the error in agentRun, not in content", async () => {
    const { store, get } = await setup();
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "partial" });
    store.getState().applyStreamEvent("draft-assistant-1", { type: "error", message: "boom" });

    expect(get()?.content).toBe("partial");
    expect(get()?.agentRun).toMatchObject({ status: "failed", error: "boom" });

    store.getState().addMessage(agentDraft("draft-assistant-2", "conv-a"));
    store.getState().applyStreamEvent("draft-assistant-2", { type: "error", message: "boom" });
    expect(store.getState().findMessageAnywhere("draft-assistant-2")?.content).toBe("");
  });

  test("a chat message without a run retains a safe failure reason outside content", async () => {
    const { store } = await setup();
    store.getState().addMessage({
      id: "draft-chat-1",
      conversationId: "conv-a",
      role: "assistant",
      content: "",
      mode: "chat",
      createdAt: new Date("2026-10-31T10:02:00.000Z"),
    });
    store.getState().applyStreamEvent("draft-chat-1", { type: "error", message: "boom" });
    const failed = store.getState().findMessageAnywhere("draft-chat-1");
    expect(failed?.content).toBe("");
    expect(failed?.finishReason).toBe("error");
    expect(failed?.agentRun).toBe(undefined);
  });

  test("an Agent reply without a run records failure in a run, never Chat metadata", async () => {
    const { store } = await setup();
    const draft = agentDraft("no-run", "conv-a");
    delete draft.agentRun;
    draft.content = "partial Agent answer";
    store.getState().addMessage(draft);
    store.getState().applyStreamEvent("no-run", {
      type: "error",
      message: "boom",
      errorCode: "chat_context_budget_exceeded",
    });
    const failed = store.getState().findMessageAnywhere("no-run");
    expect(failed?.content).toBe("partial Agent answer");
    expect(failed?.agentRun).toMatchObject({ status: "failed", error: "boom" });
    expect(failed?.finishReason).toBe(undefined);
  });

  test("background (cached) messages keep content in sync too", async () => {
    const { store, get } = await setup();
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "one" });
    await store.getState().selectConversation("conv-b");

    store.getState().applyStreamEvent("draft-assistant-1", {
      type: "agent_event",
      event: { type: "tool_start", toolName: "Read", toolCallId: "t1" },
    });
    store.getState().applyStreamEvent("draft-assistant-1", { type: "delta", content: "two" });
    store.getState().applyStreamEvent("draft-assistant-1", {
      type: "done",
      messageId: "draft-assistant-1",
    });

    expect(get()).toMatchObject({ content: "one\n\ntwo" });
    expect(get()?.agentRun?.status).toBe("completed");
  });

  test("a server task-backed done event derives content from its text step, like the DB", async () => {
    const { store, get } = await setup();
    // A server-run turn streams nothing; its single done event carries the run.
    const answer = `full answer ${"x".repeat(500)}`;
    store.getState().applyStreamEvent("draft-assistant-1", {
      type: "done",
      messageId: "draft-assistant-1",
      agentRun: {
        status: "completed",
        summary: "full answer xxx",
        steps: [{ type: "text", content: answer }],
        taskId: "task-1",
      },
    });
    expect(get()?.content).toBe(answer);

    // No final result yet: no text step, so no reply text — never the summary.
    store.getState().addMessage({ ...agentDraft("draft-assistant-2", "conv-a"), content: "stale" });
    store.getState().applyStreamEvent("draft-assistant-2", {
      type: "done",
      messageId: "draft-assistant-2",
      agentRun: { status: "awaiting_approval", summary: "Task is awaiting approval.", steps: [] },
    });
    expect(store.getState().findMessageAnywhere("draft-assistant-2")?.content).toBe("");
  });
});
