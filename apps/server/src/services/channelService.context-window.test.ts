import { expect, mock, test } from "bun:test";
import * as requestUserNamespace from "../utils/requestUser";

const realRequestUser = { ...requestUserNamespace };

import { channelModels, channels, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { encrypt } from "../utils";
import {
  fetchChannelModels,
  getResolvedChannelById,
  getResolvedChannelForConversation,
  listChannelModels,
  updateChannelModels,
} from "./channelService";
import {
  editUserMessage,
  prepareChatForSidecar,
  regenerateMessage,
  sendMessage,
  streamMessage,
} from "./messageService";

async function withFixture(
  run: (ids: { userId: string; channelId: string; conversationId: string }) => Promise<void>,
) {
  const priorKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "context-window-test-only-key";
  const userId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.local`,
      username: "context",
      passwordHash: "x",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channels).values({
      id: channelId,
      userId,
      name: "Context fixture",
      provider: "openai",
      protocol: "openai",
      apiKey: encrypt("fixture-key"),
      baseUrl: "http://127.0.0.1:1/v1",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    // Seed an existing roster without invoking the Add/discovery workflow.
    await db.insert(channelModels).values(
      [
        { modelId: "small-fixture", isDefault: true, contextWindow: 16_384 },
        { modelId: "gpt-6-astra" },
        { modelId: "gateway-large", contextWindow: 1_000_000 },
      ].map((model) => ({
        ...model,
        id: crypto.randomUUID(),
        channelId,
        displayName: model.modelId,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.update(channels).set({ model: "small-fixture" }).where(eq(channels.id, channelId));
    await db.insert(conversations).values({
      id: conversationId,
      userId,
      channelId,
      modelId: "gpt-6-astra",
      title: "Context fixture",
      forceWebSearch: false,
      createdAt: now,
      updatedAt: now,
    });
    await run({ userId, channelId, conversationId });
  } finally {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(channelModels).where(eq(channelModels.channelId, channelId));
    await db.delete(channels).where(eq(channels.id, channelId));
    await db.delete(users).where(eq(users.id, userId));
    if (priorKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = priorKey;
  }
}

test("per-model context override persists, omitted legacy updates preserve it, null clears it", async () => {
  await withFixture(async ({ userId, channelId }) => {
    const listed = await listChannelModels(userId, channelId);
    expect(listed.find((model) => model.modelId === "gateway-large")?.contextWindow).toBe(
      1_000_000,
    );
    const asUpdate = listed.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      enabled: model.enabled,
      isDefault: model.isDefault,
    }));
    await updateChannelModels(userId, channelId, { models: asUpdate });
    expect(
      (await listChannelModels(userId, channelId)).find(
        (model) => model.modelId === "gateway-large",
      )?.contextWindow,
    ).toBe(1_000_000);
    await updateChannelModels(userId, channelId, {
      models: asUpdate.map((model) => ({
        ...model,
        ...(model.modelId === "gateway-large" ? { contextWindow: null } : {}),
      })),
    });
    expect(
      (await listChannelModels(userId, channelId)).find(
        (model) => model.modelId === "gateway-large",
      )?.contextWindow,
    ).toBe(null);
  });
});

test("invalid context capacities reject before reconciliation mutates model rows", async () => {
  await withFixture(async ({ userId, channelId }) => {
    const before = await listChannelModels(userId, channelId);
    for (const invalid of [0, -1, 8191, 2_000_001, 16_384.5, Number.NaN, "1000000"] as const) {
      await expect(
        updateChannelModels(userId, channelId, {
          models: [{ modelId: "small-fixture", isDefault: true, contextWindow: invalid as number }],
        }),
      ).rejects.toThrow("Context window");
      expect(await listChannelModels(userId, channelId)).toEqual(before);
    }
  });
});

test("explicit selected model credentials and conversation resolution never use the default model capacity", async () => {
  await withFixture(async ({ userId, channelId }) => {
    expect((await getResolvedChannelById(userId, channelId))?.contextWindow).toBe(16_384);
    expect((await getResolvedChannelById(userId, channelId, "gateway-large"))?.contextWindow).toBe(
      1_000_000,
    );
    const selected = await getResolvedChannelForConversation(userId, {
      channelId,
      modelId: "gpt-6-astra",
    });
    expect(selected?.modelId).toBe("gpt-6-astra");
    expect(selected?.contextWindow).toBe(null);
    expect(await getResolvedChannelById(userId, channelId, "missing")).toBe(null);
    await expect(
      getResolvedChannelById("other-user", channelId, "gateway-large"),
    ).rejects.toThrow();
  });
});

test("real sidecar preparation accepts a large selected-model request and retains over 200 earlier messages", async () => {
  await withFixture(async ({ userId, conversationId }) => {
    const prior = Array.from({ length: 242 }, (_, index) => ({
      id: crypto.randomUUID(),
      conversationId,
      role: index % 2 ? "assistant" : "user",
      content: index === 0 ? "OLDEST-CONTEXT-SENTINEL" : `history ${index}`,
      mode: "chat",
      createdAt: new Date(Date.now() - 300_000 + index * 1000),
    }));
    await db.insert(messages).values(prior);
    const content = `CURRENT-BEGIN\n${"x".repeat(140_000)}\nCURRENT-END`;
    const prepared = await prepareChatForSidecar(userId, { conversationId, content });
    expect(prepared.contextWindow).toBe(null);
    expect(prepared.model).toBe("gpt-6-astra");
    expect(prepared.messages.some((message) => message.content === "OLDEST-CONTEXT-SENTINEL")).toBe(
      true,
    );
    expect(prepared.messages.at(-1)?.content).toBe(content);
    expect(prepared.messages.filter((message) => message.role !== "system")).toHaveLength(243);
    await db
      .update(conversations)
      .set({ modelId: "small-fixture" })
      .where(eq(conversations.id, conversationId));
    await expect(prepareChatForSidecar(userId, { conversationId, content })).rejects.toThrow(
      "context budget",
    );
    const failed = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(failed.some((message) => message.finishReason === "context_budget_exceeded")).toBe(true);
  });
});

test("model synchronization preserves existing channel-specific capacity", async () => {
  await withFixture(async ({ userId, channelId }) => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "small-fixture" }, { id: "gpt-6-astra" }, { id: "gateway-large" }],
        }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const result = await fetchChannelModels(userId, channelId);
      expect(result.success).toBe(true);
      expect(result.models.find((model) => model.modelId === "gateway-large")?.contextWindow).toBe(
        1_000_000,
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

test("additive context-window schema survives repeated bootstrap with stored model values", async () => {
  await withFixture(async ({ userId, channelId }) => {
    await bootstrapDatabase();
    await bootstrapDatabase();
    const columns = await client.execute("PRAGMA table_info(channel_models)");
    expect(columns.rows.filter((row) => row.name === "context_window")).toHaveLength(1);
    expect(
      (await listChannelModels(userId, channelId)).find(
        (model) => model.modelId === "gateway-large",
      )?.contextWindow,
    ).toBe(1_000_000);
  });
});

test("real Chat send, SSE, edit and retry submit selected large-model context to the adapter", async () => {
  const requests: Array<{
    stream?: boolean;
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [] });
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      if (!body.stream)
        return Response.json({ choices: [{ message: { content: "direct_model" } }] });
      return new Response(
        'data: {"choices":[{"delta":{"content":"CONTEXT-OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    await withFixture(async ({ userId, channelId, conversationId }) => {
      await db
        .update(channels)
        .set({ baseUrl: `http://127.0.0.1:${server.port}/v1` })
        .where(eq(channels.id, channelId));
      const large = `Rewrite the following text without web search: BEGIN\n${"x".repeat(140_000)}\nEND`;
      const result = await sendMessage(userId, { conversationId, content: large });
      expect(result.assistantMessage.content).toBe("CONTEXT-OK");
      const streamed = await new Response(
        await streamMessage(userId, { conversationId, content: large, mode: "chat" }),
      ).text();
      expect(streamed.includes("CONTEXT-OK")).toBe(true);
      await new Response(
        await editUserMessage(userId, result.userMessage.id, `${large}\nEDIT`, {
          appendSystemPrompt: "FINAL-UI-INSTRUCTIONS",
        }),
      ).text();
      await new Response(
        await regenerateMessage(userId, result.assistantMessage.id, {
          appendSystemPrompt: "RETRY-UI-INSTRUCTIONS",
        }),
      ).text();
      const completions = requests.filter((request) => request.stream);
      expect(completions).toHaveLength(4);
      for (const completion of completions) {
        expect(completion.model).toBe("gpt-6-astra");
        expect(completion.max_tokens).toBe(4096);
        expect(
          completion.messages.some(
            (message) => message.role === "user" && message.content.includes("x".repeat(140_000)),
          ),
        ).toBe(true);
      }
      expect(
        completions[2]?.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("FINAL-UI-INSTRUCTIONS"),
        ),
      ).toBe(true);
      expect(
        completions[3]?.messages.some(
          (message) =>
            message.role === "system" && message.content.includes("RETRY-UI-INSTRUCTIONS"),
        ),
      ).toBe(true);
    });
  } finally {
    await server.stop(true);
  }
});

test("credentials HTTP endpoint carries the selected capacity and rejects an unknown requested model", async () => {
  await withFixture(async ({ userId, channelId }) => {
    mock.module("../utils/requestUser", () => ({
      ...realRequestUser,
      requireUser: async (
        context: { set: (key: string, value: unknown) => void },
        next: () => Promise<void>,
      ) => {
        context.set("user", { id: userId });
        return next();
      },
    }));
    try {
      const { default: routes } = await import(`../routes/channels?context=${crypto.randomUUID()}`);
      const response = await routes.request(`/${channelId}/credentials?modelId=gateway-large`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        credentials: { modelId: string; contextWindow: number };
      };
      expect(body.credentials.modelId).toBe("gateway-large");
      expect(body.credentials.contextWindow).toBe(1_000_000);
      const rejected = await routes.request(`/${channelId}/credentials?modelId=missing`);
      expect(rejected.status).toBe(400);
      await db
        .update(channels)
        .set({ protocol: "acp", apiKey: encrypt(JSON.stringify({ command: "fixture-acp" })) })
        .where(eq(channels.id, channelId));
      const live = await routes.request(`/${channelId}/credentials?modelId=live-session-model`);
      expect(live.status).toBe(200);
      const liveBody = (await live.json()) as {
        credentials: { modelId: string; contextWindow: number | null };
      };
      expect(liveBody.credentials.modelId).toBe("live-session-model");
      expect(liveBody.credentials.contextWindow).toBe(null);
      const persisted = await routes.request(`/${channelId}/credentials?modelId=gateway-large`);
      expect(persisted.status).toBe(200);
      expect(
        ((await persisted.json()) as { credentials: { contextWindow: number } }).credentials
          .contextWindow,
      ).toBe(1_000_000);
    } finally {
      mock.module("../utils/requestUser", () => realRequestUser);
    }
  });
});
