import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { conversations, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import * as realRequestUserNs from "../utils/requestUser";
import * as realChannelsNs from "./channelService";
import {
  ChatModeUnsupportedError,
  editUserMessage,
  prepareChatForSidecar,
  regenerateMessage,
  sendMessage,
  streamMessage,
} from "./messageService";

const realChannels = { ...realChannelsNs };
const realRequestUser = { ...realRequestUserNs };
let channelResolutions = 0;
let routeUserId = "";
beforeAll(() => {
  mock.module("./channelService", () => ({
    ...realChannels,
    getResolvedChannelForConversation: async () => {
      channelResolutions += 1;
      return {
        channel: { id: "fixture-acp", protocol: "acp", baseUrl: null },
        apiKey: "fixture-config",
        modelId: "fixture-agent",
      };
    },
  }));
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
});
afterAll(() => {
  mock.module("./channelService", () => realChannels);
  mock.module("../utils/requestUser", () => realRequestUser);
});

async function seed() {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const now = new Date(Date.now() - 60_000);
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "fixture",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "ACP",
    defaultMode: "chat",
    lastMode: "chat",
    forceWebSearch: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    {
      id: userMessageId,
      conversationId,
      role: "user",
      content: "original question",
      mode: "chat",
      createdAt: now,
    },
    {
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "original answer",
      mode: "chat",
      createdAt: new Date(now.getTime() + 1000),
    },
  ]);
  return {
    userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    snapshot: async () => ({
      messages: await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt)),
      conversation: (
        await db.select().from(conversations).where(eq(conversations.id, conversationId))
      )[0],
    }),
    cleanup: async () => {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

for (const operation of ["send", "stream", "prepare", "edit", "regenerate", "fallback"] as const) {
  test(`ACP Chat ${operation} refuses before mutating messages or conversation`, async () => {
    const fixture = await seed();
    const { userId, conversationId, userMessageId, assistantMessageId } = fixture;
    try {
      const before = await fixture.snapshot();
      const input = { conversationId, content: "new question", mode: "chat" as const };
      const invoke = (callerId: string) =>
        operation === "send"
          ? sendMessage(callerId, input)
          : operation === "stream"
            ? streamMessage(callerId, input)
            : operation === "prepare"
              ? prepareChatForSidecar(callerId, input)
              : operation === "edit"
                ? editUserMessage(callerId, userMessageId, "edited question")
                : operation === "regenerate"
                  ? regenerateMessage(callerId, assistantMessageId)
                  : regenerateMessage(callerId, "unknown-assistant", {
                      fallbackUserMessageId: userMessageId,
                      fallbackUserContent: "edited question",
                    });
      const resolutionsBefore = channelResolutions;
      await expect(invoke(crypto.randomUUID())).rejects.toThrow("Conversation not found");
      expect(channelResolutions).toBe(resolutionsBefore);
      await expect(invoke(userId)).rejects.toBeInstanceOf(ChatModeUnsupportedError);
      expect(await fixture.snapshot()).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const operation of ["send", "stream", "prepare", "edit", "regenerate"] as const) {
  test(`ACP Chat ${operation} returns a typed HTTP 400 before opening an SSE stream`, async () => {
    const fixture = await seed();
    routeUserId = fixture.userId;
    try {
      const before = await fixture.snapshot();
      const { default: routes } = await import(`../routes/messages?acp=${crypto.randomUUID()}`);
      const path =
        operation === "send"
          ? "/"
          : operation === "stream"
            ? "/stream"
            : operation === "prepare"
              ? "/chat/prepare"
              : operation === "edit"
                ? `/${fixture.userMessageId}/edit`
                : `/${fixture.assistantMessageId}/regenerate`;
      const response = await routes.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: fixture.conversationId,
          content: "new question",
          mode: "chat",
        }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await response.json()).toEqual({
        error: new ChatModeUnsupportedError().message,
        code: "chat_mode_unsupported",
      });
      expect(await fixture.snapshot()).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });
}
