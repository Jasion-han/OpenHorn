import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { conversations, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
import * as realAgentAdaptersNs from "../agent-adapters";
import { db } from "../db";
import * as realRequestUserNs from "../utils/requestUser";
import * as realChannelServiceNs from "./channelService";
import {
  completeChatFromSidecar,
  editUserMessage,
  prepareChatForSidecar,
  regenerateMessage,
  sendMessage,
  streamMessage,
} from "./messageService";

// Bun module mocks are global. Preserve/restore the real namespace so running
// this file with other service suites cannot leak its provider into them.
const realRequestUser = { ...realRequestUserNs };
let routeUserId = "";
let calls = 0;
const realAgentAdapters = { ...realAgentAdaptersNs };
const realChannelService = { ...realChannelServiceNs };
const partial = "```openui\nroot = Card(";
const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
let output = partial;
let failed = true;

beforeAll(() => {
  mock.module("../utils/requestUser", () => ({
    ...realRequestUser,
    requireUser: async (
      c: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("user", { id: routeUserId });
      return next();
    },
  }));
  mock.module("./channelService", () => ({
    ...realChannelService,
    getResolvedChannelForConversation: async () => ({
      channel: { id: "truncation-fixture", protocol: "openai", baseUrl: null },
      apiKey: "fixture-key",
      modelId: "fixture-model",
    }),
  }));
  mock.module("../agent-adapters", () => ({
    ...realAgentAdapters,
    createAdapter: () => ({
      chatStream: async function* () {
        calls += 1;
        if (output) yield output;
        if (failed) throw new Error("provider disconnected: secret-fixture-token");
        return usage;
      },
    }),
  }));
});

afterAll(() => {
  mock.module("../utils/requestUser", () => realRequestUser);
  mock.module("./channelService", () => realChannelService);
  mock.module("../agent-adapters", () => realAgentAdapters);
});

async function fixture(withReply = true) {
  output = partial;
  failed = true;
  calls = 0;
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const at = Date.now() - 60_000;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "truncation",
    contextLength: 4096,
    defaultMode: "chat",
    lastMode: "chat",
    isPinned: false,
    forceWebSearch: false,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
  await db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    content: "question",
    mode: "chat",
    createdAt: new Date(at),
  });
  if (withReply)
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "previous answer",
      mode: "chat",
      finishReason: "stopped",
      usage: JSON.stringify({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
      createdAt: new Date(at + 1000),
    });
  return {
    userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    async cleanup() {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

async function rows(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function events(stream: ReadableStream) {
  const raw = await new Response(stream).text();
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

for (const operation of ["prepare", "send", "stream", "edit", "edit-tail", "retry"] as const) {
  test(`over-budget ${operation} retains safe termination metadata without calling completion`, async () => {
    const ids = await fixture(operation !== "edit-tail");
    const huge = "x".repeat(113_000);
    try {
      if (operation === "retry") {
        await db.update(messages).set({ content: huge }).where(eq(messages.id, ids.userMessageId));
      }
      if (operation === "prepare" || operation === "send") {
        await expect(
          operation === "prepare"
            ? prepareChatForSidecar(ids.userId, {
                conversationId: ids.conversationId,
                content: huge,
              })
            : sendMessage(ids.userId, { conversationId: ids.conversationId, content: huge }),
        ).rejects.toThrow("estimated context budget");
      } else {
        const received = await events(
          operation === "stream"
            ? await streamMessage(ids.userId, {
                conversationId: ids.conversationId,
                content: huge,
                mode: "chat",
              })
            : operation === "retry"
              ? await regenerateMessage(ids.userId, ids.assistantMessageId)
              : await editUserMessage(ids.userId, ids.userMessageId, huge),
        );
        const terminal = received.filter(
          (event) => event.type === "error" || event.type === "done",
        );
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          type: "error",
          errorCode: "chat_context_budget_exceeded",
          content: "",
        });
      }
      const saved = await rows(ids.conversationId);
      const reply = saved.filter((row) => row.role === "assistant").at(-1);
      expect(calls).toBe(0);
      expect(reply?.content).toBe(operation === "retry" ? "previous answer" : "");
      expect(reply?.finishReason).toBe(
        operation === "retry" ? "stopped" : "context_budget_exceeded",
      );
      if (operation === "retry")
        expect(JSON.parse(reply?.usage ?? "null")).toEqual({
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
        });
    } finally {
      await ids.cleanup();
    }
  });
}

test("HTTP prepare failure returns saved pair identity and a safe code, without provider credentials", async () => {
  const ids = await fixture();
  routeUserId = ids.userId;
  try {
    const { default: routes } = await import(`../routes/messages?budget=${crypto.randomUUID()}`);
    const response = await routes.request("/chat/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: ids.conversationId, content: "x".repeat(113_000) }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("chat_context_budget_exceeded");
    const saved = await rows(ids.conversationId);
    expect(saved.find((row) => row.id === body.userMessageId)?.role).toBe("user");
    expect(saved.find((row) => row.id === body.assistantMessageId)?.finishReason).toBe(
      "context_budget_exceeded",
    );
    expect(JSON.stringify(body).includes("fixture-key")).toBe(false);
  } finally {
    await ids.cleanup();
  }
});

for (const operation of ["nonstream", "stream", "edit", "retry"] as const) {
  test(`provider failure keeps exact partial Markdown and safe state across ${operation}`, async () => {
    const ids = await fixture();
    try {
      if (operation === "nonstream") {
        await sendMessage(ids.userId, {
          conversationId: ids.conversationId,
          content: "next question",
        });
      } else {
        await events(
          operation === "stream"
            ? await streamMessage(ids.userId, {
                conversationId: ids.conversationId,
                content: "next question",
                mode: "chat",
              })
            : operation === "edit"
              ? await editUserMessage(ids.userId, ids.userMessageId, "edited question")
              : await regenerateMessage(ids.userId, ids.assistantMessageId),
        );
      }
      const reply = (await rows(ids.conversationId))
        .filter((row) => row.role === "assistant")
        .at(-1);
      expect(reply?.content).toBe(partial);
      expect(reply?.finishReason).toBe("error");
      expect(JSON.stringify(reply).includes("secret-fixture-token")).toBe(false);
    } finally {
      await ids.cleanup();
    }
  });
}

test("sidecar completion persists bounded failure reasons and success clears them", async () => {
  const ids = await fixture();
  try {
    for (const finishReason of [
      "context_budget_exceeded",
      "error",
      "stopped",
      "length",
      undefined,
      "unsafe arbitrary error",
    ]) {
      await completeChatFromSidecar(ids.userId, {
        assistantMessageId: ids.assistantMessageId,
        conversationId: ids.conversationId,
        content: "",
        finishReason,
      });
      const reply = (await rows(ids.conversationId)).find(
        (row) => row.id === ids.assistantMessageId,
      );
      expect(reply?.content).toBe("");
      expect(reply?.finishReason).toBe(
        finishReason === "unsafe arbitrary error" || finishReason === undefined
          ? null
          : finishReason,
      );
    }
  } finally {
    await ids.cleanup();
  }
});
