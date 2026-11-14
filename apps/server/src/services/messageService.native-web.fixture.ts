import { expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}

const dir = mkdtempSync(path.join(tmpdir(), "openhorn-native-chat-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(dir, "fixture.db")}`;
const { db, client } = await import("../db");
const realChannel = { ...(await import("./channelService")) };
let baseUrl = "https://api.deepseek.com/v1";
mock.module("./channelService", () => ({
  ...realChannel,
  getResolvedChannelForConversation: async () => ({
    channel: { id: "native-fixture", protocol: "openai", baseUrl },
    apiKey: "synthetic-key",
    modelId: "deepseek-flash",
  }),
}));
const { users, conversations, messages } = await import("db");
const { eq } = await import("drizzle-orm");
const { setSettingValue } = await import("./settingsService");
const service = await import("./messageService");
const { LIBRARY_SYSTEM_TAG } = await import("shared/library");
let requests: Record<string, unknown>[] = [];
let reason = "stop";
let output = "😀native answer";
const toolCalls = [
  {
    index: 0,
    calls: [
      {
        index: 0,
        id: "read1",
        type: "deepseek_read_url",
        kind: "read_link",
        action: { type: "read_link", url: "https://example.com/" },
        status: "completed",
        page: { url: "https://example.com/", title: "Example" },
        signature: "opaque+unmodified/==",
      },
    ],
  },
];
const state = {
  provider: "deepseek" as const,
  origin: "https://api.deepseek.com",
  model: "deepseek-flash",
  serverToolCalls: toolCalls,
};
const citations = [{ url: "https://example.com/", title: "Example" }];
globalThis.fetch = (async (url, init) => {
  if (!String(url).endsWith("/chat/completions"))
    throw new Error(`Unexpected external request: ${url}`);
  const body = JSON.parse(String(init?.body));
  requests.push(body);
  const frames = [
    ...(output ? [{ choices: [{ delta: { content: output } }] }] : []),
    {
      choices: [
        {
          delta: {
            server_tool_calls: toolCalls,
            annotations: [{ type: "url_citation", url_citation: citations[0] }],
          },
          finish_reason: reason,
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ];
  return new Response(
    `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}) as typeof fetch;
try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase();
  const now = new Date();
  const [localUser] = await db.select().from(users).limit(1);
  const userId = localUser?.id ?? crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  if (!localUser)
    await db.insert(users).values({
      id: userId,
      email: `${userId}@native.invalid`,
      username: "native",
      createdAt: now,
      updatedAt: now,
    });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "Native",
    forceWebSearch: true,
    createdAt: now,
    updatedAt: now,
  });
  await setSettingValue(userId, "deepseek.nativeWebEnabled", "true");
  const prepared = await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "hello",
  });
  expect(prepared.nativeWeb).toEqual({ search: true, readUrls: true, thinking: true });
  expect(requests.length).toBe(0);
  const rows = () => db.select().from(messages).where(eq(messages.conversationId, conversationId));
  const row = () =>
    rows().then((r) => required(r.find((m) => m.id === prepared.assistantMessageId)));
  expect(JSON.parse((await row()).providerState ?? "null")).toMatchObject({
    origin: state.origin,
    model: state.model,
    serverToolCalls: [],
  });
  // Frozen identity remains valid even after the conversation's selected channel changes.
  baseUrl = "https://gateway.invalid";
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "answer",
    model: state.model,
    providerState: state,
    citations,
    liveMetadata: {
      status: "live",
      route: "web_search",
      sourceType: "web_search",
      native: { steps: [{ id: "read1", action: "read_link", status: "completed" }] },
    },
  });
  expect(JSON.parse((await row()).providerState ?? "null")).toEqual(state);
  const largeState = {
    ...state,
    serverToolCalls: [
      {
        index: 0,
        calls: [
          {
            index: 0,
            id: "read-large",
            type: "deepseek_read_url",
            kind: "read_link",
            action: { type: "read_link", url: "https://example.com/large" },
            status: "completed",
            signature: "s".repeat(70_000),
          },
        ],
      },
    ],
  };
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "large signed page",
    providerState: largeState,
    nativeMetadata: {
      providerState: largeState,
      steps: [{ id: "read-large", action: "read_link", status: "completed" }],
    },
  });
  expect(
    JSON.parse((await row()).providerState ?? "null").serverToolCalls[0].calls[0].signature.length,
  ).toBe(70_000);
  expect(JSON.parse((await row()).liveMetadata ?? "{}").native.providerState).toBeUndefined();
  const switchedHistory = await service.buildChatMessages(
    userId,
    [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "short answer", providerState: JSON.stringify(largeState) },
      { role: "user", content: "current" },
    ],
    LIBRARY_SYSTEM_TAG,
    null,
    {
      maxTokens: 100,
      replaySource: { protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
    },
  );
  expect(switchedHistory.map((message) => message.content)).toEqual([
    LIBRARY_SYSTEM_TAG,
    "earlier",
    "short answer",
    "current",
  ]);
  expect(switchedHistory.some((message) => message.providerState !== undefined)).toBe(false);
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "answer",
    providerState: state,
  });
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "legacy update",
  });
  expect(JSON.parse((await row()).providerState ?? "null")).toEqual(state);
  expect(JSON.parse((await row()).citations ?? "null")).toEqual(citations);
  await expect(
    service.completeChatFromSidecar(userId, {
      conversationId,
      assistantMessageId: prepared.assistantMessageId,
      content: "forged",
      providerState: { ...state, model: "deepseek-v4-flash-vision-exp" },
    }),
  ).rejects.toThrow();
  await expect(
    service.completeChatFromSidecar("other-user", {
      conversationId,
      assistantMessageId: prepared.assistantMessageId,
      content: "forged",
      providerState: state,
    }),
  ).rejects.toThrow();
  expect((await row()).content).toBe("legacy update");
  const forgedId = crypto.randomUUID();
  await db.insert(messages).values({
    id: forgedId,
    conversationId,
    role: "assistant",
    content: "ordinary",
    model: state.model,
    mode: "chat",
    createdAt: new Date(),
  });
  await expect(
    service.completeChatFromSidecar(userId, {
      conversationId,
      assistantMessageId: forgedId,
      content: "forged",
      providerState: state,
    }),
  ).rejects.toThrow();
  // Aggregate metadata can be supplied separately; signatures stay out of display JSON.
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "legacy update",
    nativeMetadata: {
      providerState: state,
      citations,
      steps: [{ id: "s", action: "search", status: "completed", query: "fixture" }],
      toolUsage: { search: 1, fetch: 0, imageSearch: 0 },
    },
  });
  expect((await row()).liveMetadata?.includes("signature")).toBe(false);
  expect(JSON.parse((await row()).liveMetadata ?? "null").native.toolUsage.search).toBe(1);
  await expect(
    service.completeChatFromSidecar(userId, {
      conversationId,
      assistantMessageId: prepared.assistantMessageId,
      content: "forged",
      nativeMetadata: { providerState: { ...state, model: "deepseek-v4-flash-vision-exp" } },
    }),
  ).rejects.toThrow();
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "stopped partial",
    finishReason: "stopped",
    nativeMetadata: { refused: true },
  });
  expect((await row()).content).toBe("stopped partial");
  expect((await row()).finishReason).toBe("stopped");
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: prepared.assistantMessageId,
    content: "legacy update",
  });
  baseUrl = "https://api.deepseek.com";
  const second = await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "follow up",
  });
  expect(
    second.messages.find((m) => m.role === "assistant" && m.content === "legacy update")
      ?.providerState,
  ).toEqual(state);
  const source = await service.buildChatMessages(
    userId,
    [
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a", providerState: JSON.stringify(state) },
      { role: "user", content: "new q" },
    ],
    LIBRARY_SYSTEM_TAG,
  );
  expect(source[2]?.providerState).toEqual(state);
  const bounded = await service.buildChatMessages(
    userId,
    [
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a", providerState: JSON.stringify(state) },
      { role: "user", content: "new q" },
    ],
    LIBRARY_SYSTEM_TAG,
    null,
    { maxTokens: 160 },
  );
  expect(bounded.some((m) => m.role === "assistant")).toBe(false);
  reason = "content_filter";
  const stream = await service.streamMessage(userId, {
    conversationId,
    content: "native SSE",
    mode: "chat",
  });
  const wire = await new Response(stream).text();
  expect(wire.includes('"type":"chat_metadata"')).toBe(true);
  expect(wire.includes('"errorCode":"response_refused"')).toBe(true);
  const latest = required((await rows()).at(-1));
  expect(latest.content).toBe("");
  expect(latest.finishReason).toBe("refused");
  expect(JSON.parse(latest.citations ?? "[]")).toEqual([]);
  expect(JSON.parse(latest.liveMetadata ?? "null").native.refused).toBe(true);
  expect(latest.liveMetadata?.includes("signature")).toBe(false);
  // A normal failed/empty retry preserves its entire previous answer, including state.
  reason = "stop";
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: second.assistantMessageId,
    content: "previous",
    model: state.model,
    providerState: state,
    citations,
  });
  output = "";
  reason = "length";
  const retry = await service.regenerateMessage(userId, second.assistantMessageId);
  await new Response(retry).text();
  const preserved = required((await rows()).find((m) => m.id === second.assistantMessageId));
  expect(preserved.content).toBe("previous");
  expect(JSON.parse(preserved.providerState ?? "null")).toEqual(state);
  expect(JSON.parse(preserved.citations ?? "null")).toEqual(citations);
  // Refusal is a replacement even when its final text is empty.
  reason = "content_filter";
  await new Response(await service.regenerateMessage(userId, second.assistantMessageId)).text();
  expect((await rows()).find((m) => m.id === second.assistantMessageId)?.finishReason).toBe(
    "refused",
  );
  output = "updated reply";
  reason = "stop";
  const edited = await service.editUserMessage(
    userId,
    second.userMessageId,
    "edited native question",
  );
  const editedWire = await new Response(edited).text();
  expect(editedWire.includes('"type":"chat_metadata"')).toBe(true);
  const editedRow = required((await rows()).find((m) => m.id === second.assistantMessageId));
  expect(editedRow.content).toBe(output);
  expect(JSON.parse(editedRow.providerState ?? "null")).toEqual(state);
  expect(JSON.parse(editedRow.citations ?? "null")).toEqual(citations);
  reason = "content_filter";
  const nonstream = await service.sendMessage(userId, {
    conversationId,
    content: "nonstream native",
    mode: "chat",
  });
  expect(nonstream.assistantMessage.content).toBe("");
  expect(nonstream.assistantMessage.finishReason).toBe("refused");
  expect(nonstream.errorCode).toBe("response_refused");
  expect(requests.every((request) => request.tools !== undefined)).toBe(true);
  await setSettingValue(userId, "chat.systemPrompt", LIBRARY_SYSTEM_TAG);
  requests = [];
  const dataOnly = await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "https://example.com data",
  });
  expect(dataOnly.nativeWeb).toBeUndefined();
  expect(requests).toHaveLength(0);
  output = "local data";
  reason = "stop";
  await new Response(
    await service.streamMessage(userId, {
      conversationId,
      content: "https://example.com data",
      mode: "chat",
    }),
  ).text();
  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toBeUndefined();
  // A failed URL fetch must still constrain what the model may claim about reading it.
  await setSettingValue(userId, "chat.systemPrompt", "");
  await setSettingValue(userId, "deepseek.nativeWebEnabled", "false");
  const liveNs = { ...(await import("./liveCapabilities")) };
  const searchNs = { ...(await import("./searchService")) };
  let linkUrls: string[] = [];
  mock.module("./liveCapabilities", () => ({
    ...liveNs,
    buildLiveContext: async () => ({
      status: "live",
      route: "web_search",
      source: { type: "web_search", provider: "fixture" },
      systemContext: "SEARCH-SUMMARY-ONLY",
      citations,
    }),
  }));
  mock.module("./searchService", () => ({
    ...searchNs,
    buildLinkContext: async (input: { urls: string[] }) => {
      linkUrls = input.urls;
      return {
        status: "offline",
        provider: "none",
        label: "not read",
        citations: [],
        systemContext: "FETCH-FAILED: Do not claim to have read these pages.",
      };
    },
  }));
  const linksFailed = await service.prepareChatForSidecar(userId, {
    conversationId,
    content:
      "Read https://example.com/a。 https://example.com/b， https://example.com/c！ https://example.com/d",
  });
  const instructions = linksFailed.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  expect(instructions.includes("FETCH-FAILED")).toBe(true);
  expect(instructions.includes("SEARCH-SUMMARY-ONLY")).toBe(true);
  expect(linksFailed.liveMetadata?.status).toBe("live");
  expect(linksFailed.citations).toEqual(citations);
  expect(linkUrls).toEqual([
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
  await service.completeChatFromSidecar(userId, {
    conversationId,
    assistantMessageId: linksFailed.assistantMessageId,
    content: "late partial",
    finishReason: "refused",
    nativeMetadata: { refused: true },
  });
  expect(
    (await rows()).find((message) => message.id === linksFailed.assistantMessageId)?.content,
  ).toBe("");
  // Exercise the real central HTTP transport against the same isolated database.
  await setSettingValue(userId, "deepseek.nativeWebEnabled", "true");
  const { Hono } = await import("hono");
  const { default: routes } = await import("../routes/messages");
  const app = new Hono();
  app.route("/messages", routes);
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const httpPrepared = await post("/messages/chat/prepare", {
    conversationId,
    content: "HTTP native",
  });
  expect(httpPrepared.status).toBe(200);
  const httpTurn = (await httpPrepared.json()) as {
    userMessageId: string;
    assistantMessageId: string;
    liveMetadata: unknown;
    nativeWeb: unknown;
  };
  expect(httpTurn.nativeWeb).toEqual({ search: true, readUrls: true, thinking: true });
  const httpCompleted = await post("/messages/chat/complete", {
    conversationId,
    assistantMessageId: httpTurn.assistantMessageId,
    content: "HTTP answer",
    model: state.model,
    providerState: state,
    citations,
    liveMetadata: httpTurn.liveMetadata,
    nativeMetadata: {
      providerState: state,
      citations,
      toolUsage: { search: 1, fetch: 1, imageSearch: 0 },
    },
  });
  expect(httpCompleted.status).toBe(200);
  const listed = (await (await app.request(`/messages/${conversationId}`)).json()) as {
    messages: Array<{ id: string; content: string; providerState: string; liveMetadata: string }>;
  };
  const httpRow = required(
    listed.messages.find((message) => message.id === httpTurn.assistantMessageId),
  );
  expect(httpRow.content).toBe("HTTP answer");
  expect(JSON.parse(httpRow.providerState)).toEqual(state);
  expect(httpRow.liveMetadata.includes("signature")).toBe(false);
  reason = "stop";
  output = "HTTP edited";
  const httpEdited = await post(`/messages/${httpTurn.userMessageId}/edit`, {
    content: "HTTP edited question",
  });
  expect((await httpEdited.text()).includes('"type":"chat_metadata"')).toBe(true);
  const deleted = await app.request(`/messages/${httpTurn.assistantMessageId}`, {
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  expect((await rows()).some((message) => message.id === httpTurn.assistantMessageId)).toBe(false);
  console.log(
    JSON.stringify({
      prepare: true,
      replay: true,
      ownership: true,
      refusal: true,
      sse: true,
      retry: true,
      dataOnly: true,
      history: true,
    }),
  );
} finally {
  client.close();
  rmSync(dir, { recursive: true, force: true });
}
