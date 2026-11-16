import { expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENROUTER_SEARCH_MODEL } from "shared/openrouter-search";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value");
  return value;
}

const dir = mkdtempSync(path.join(tmpdir(), "openhorn-native-chat-"));
process.env.NODE_ENV = "test";
delete process.env.TAVILY_API_KEY;
process.env.DATABASE_URL = `file:${path.join(dir, "fixture.db")}`;
const independentRouterKey = "fixture-router-independent";
globalThis.fetch = (async (url, init) => {
  if (String(url) === "https://openrouter.ai/api/v1/chat/completions") {
    routerRequests++;
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${independentRouterKey}`);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(OPENROUTER_SEARCH_MODEL);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0].parameters.engine).toBe("exa");
    if (retrievalHold) {
      retrievalHold.signal = init?.signal ?? undefined;
      retrievalHold.entered();
      return new Promise<Response>(() => {});
    }
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Synthetic independent OpenRouter retrieval summary",
            reasoning: "private-router-reasoning",
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://example.com/", title: "Example" },
              },
            ],
          },
        },
      ],
    });
  }
  if (String(url) === "https://api.tavily.com/search") {
    searchRequests++;
    return Response.json({ results: [{ url: "https://example.com/", title: "Example" }] });
  }
  if (String(url) === "https://api.deepseek.com/v1/responses") {
    nativeRequests++;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer synthetic-independent-native",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    if (retrievalHold) {
      retrievalHold.signal = init?.signal ?? undefined;
      retrievalHold.entered();
      return new Promise<Response>(() => {});
    }
    return Response.json({
      status: "completed",
      usage: { server_tool_use: { tool_search: 1, tool_fetch: 0 } },
      output: [
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Synthetic independent retrieval summary",
              annotations: [
                { type: "url_citation", url: "https://example.com/", title: "Example" },
              ],
            },
          ],
        },
      ],
    });
  }
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

const { db, client } = await import("../db");
const realChannel = { ...(await import("./channelService")) };
let baseUrl = "https://api.deepseek.com/v1";
let answerModel = "deepseek-flash";
let answerProtocol = "openai";
let answerContextWindow: number | undefined;
let searchRequests = 0;
let nativeRequests = 0;
let routerRequests = 0;
let retrievalHold: { entered(): void; signal?: AbortSignal } | undefined;
mock.module("./channelService", () => ({
  ...realChannel,
  getResolvedChannelForConversation: async () => ({
    channel: { id: "native-fixture", protocol: answerProtocol, baseUrl },
    apiKey: "synthetic-key",
    modelId: answerModel,
    contextWindow: answerContextWindow,
  }),
}));
const { users, conversations, messages, settings, attachments } = await import("db");
const { eq } = await import("drizzle-orm");
const { setSettingValue } = await import("./settingsService");
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
const service = await import("./messageService");
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
  await db.insert(settings).values({
    id: crypto.randomUUID(),
    userId,
    key: "deepseek.nativeWebEnabled",
    value: "true",
    updatedAt: now,
  });
  await setSettingValue(userId, "liveSearch.tavilyApiKey", "synthetic-tavily");
  const { verifyAndActivateSearch, getSearchSettingsStatus } = await import(
    "./searchSettingsService"
  );
  expect(
    (
      await verifyAndActivateSearch(userId, {
        provider: "tavily",
        revision: (await getSearchSettingsStatus(userId)).revision,
      })
    ).success,
  ).toBe(true);
  searchRequests = 0;
  const prepared = await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "请联网搜索最新 DeepSeek 官方 API 文档",
  });
  expect(prepared.nativeWeb).toBeUndefined();
  expect(searchRequests).toBe(1);
  expect(prepared.citations?.map((citation) => citation.url)).toEqual(
    citations.map((citation) => citation.url),
  );
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
    "请联网搜索最新官方说明",
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
  expect(requests.every((request) => request.tools === undefined)).toBe(true);
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
  const { NATIVE_SEARCH_CONFIG } = await import("shared/deepseek-native-search");
  await setSettingValue(
    userId,
    NATIVE_SEARCH_CONFIG,
    JSON.stringify({ source: "manual", apiKey: "synthetic-independent-native" }),
  );
  const nativeActivation = await verifyAndActivateSearch(
    userId,
    { provider: "deepseek-native", revision: (await getSearchSettingsStatus(userId)).revision },
    { resolveHostname: async () => ["93.184.216.34"] },
  );
  if (nativeActivation.success === false)
    throw new Error(`Synthetic native activation failed: ${nativeActivation.errorCode}`);
  for (const [protocol, model] of [
    ["openai", "gpt-6-astra"],
    ["anthropic", "claude-opus-4-6"],
  ]) {
    answerProtocol = protocol;
    answerModel = model;
    baseUrl = "https://answer-model.example.com/v1";
    const beforeNativeRequests = nativeRequests;
    const independent = await service.prepareChatForSidecar(userId, {
      conversationId,
      content: "请联网搜索最新官方文档",
    });
    expect(nativeRequests).toBe(beforeNativeRequests + 1);
    expect(independent.model).toBe(model);
    expect(independent.protocol).toBe(protocol);
    expect(independent.apiKey).toBe("synthetic-key");
    expect(independent.nativeWeb).toBeUndefined();

    expect(independent.citations).toEqual(citations);
    expect(
      JSON.stringify(independent.messages).includes("Synthetic independent retrieval summary"),
    ).toBe(true);
    expect(JSON.stringify(independent.messages).includes("synthetic-independent-native")).toBe(
      false,
    );
  }
  const { OPENROUTER_SEARCH_CONFIG } = await import("shared/openrouter-search");
  await setSettingValue(
    userId,
    OPENROUTER_SEARCH_CONFIG,
    JSON.stringify({ apiKey: independentRouterKey }),
  );
  const routerActivation = await verifyAndActivateSearch(userId, {
    provider: "openrouter",
    revision: (await getSearchSettingsStatus(userId)).revision,
  });
  expect(routerActivation.success).toBe(true);
  for (const [protocol, model] of [
    ["openai", "gpt-6-astra"],
    ["anthropic", "claude-opus-4-6"],
  ]) {
    answerProtocol = protocol;
    answerModel = model;
    baseUrl = "https://answer-model.example.com/v1";
    const before = routerRequests;
    const independent = await service.prepareChatForSidecar(userId, {
      conversationId,
      content: "请联网搜索最新官方文档",
    });
    expect(routerRequests).toBe(before + 1);
    expect(independent.model).toBe(model);
    expect(independent.protocol).toBe(protocol);
    expect(independent.apiKey).toBe("synthetic-key");
    expect(independent.citations).toEqual(citations);
    const answerContext = JSON.stringify(independent.messages);
    expect(answerContext.includes("Synthetic independent OpenRouter retrieval summary")).toBe(true);
    expect(answerContext.includes(independentRouterKey)).toBe(false);
    expect(answerContext.includes("private-router-reasoning")).toBe(false);
    await service.completeChatFromSidecar(userId, {
      conversationId,
      assistantMessageId: independent.assistantMessageId,
      saveToken: independent.saveToken,
      content: "Source-backed answer",
      model,
      citations: independent.citations,
      liveMetadata: independent.liveMetadata,
    });
    const completed = required((await rows()).find((m) => m.id === independent.assistantMessageId));
    expect(JSON.parse(completed.citations ?? "null")).toEqual(citations);
  }
  await db
    .update(conversations)
    .set({ forceWebSearch: false })
    .where(eq(conversations.id, conversationId));
  const routerDisabledBefore = routerRequests;
  await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "请联网搜索最新官方文档",
  });
  expect(routerRequests).toBe(routerDisabledBefore);
  await db
    .update(conversations)
    .set({ forceWebSearch: true })
    .where(eq(conversations.id, conversationId));
  expect(
    (
      await verifyAndActivateSearch(userId, {
        provider: "deepseek-native",
        revision: (await getSearchSettingsStatus(userId)).revision,
      })
    ).success,
  ).toBe(true);
  answerProtocol = "openai";
  answerModel = "deepseek-flash";
  baseUrl = "https://api.deepseek.com/v1";
  // Disabled web access must gate the real Chat preparation path, even with a valid Native profile.
  await db
    .update(conversations)
    .set({ forceWebSearch: false })
    .where(eq(conversations.id, conversationId));
  const disabledCount = nativeRequests;
  const disabledTurn = await service.prepareChatForSidecar(userId, {
    conversationId,
    content: "最近AI圈有什么新闻",
  });
  expect(nativeRequests).toBe(disabledCount);
  expect(disabledTurn.citations).toBeUndefined();
  await db
    .update(conversations)
    .set({ forceWebSearch: true })
    .where(eq(conversations.id, conversationId));
  for (const stopProvider of ["deepseek-native", "openrouter"]) {
    await setSettingValue(userId, "liveSearch.provider", stopProvider);
    // Both independent providers must honor Stop through real SSE edit/retry and preparation routes.
    for (const kind of ["retry", "edit"]) {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = { entered, signal: undefined as AbortSignal | undefined };
      retrievalHold = held;
      const modelCount = requests.length;
      const response =
        kind === "retry"
          ? await service.regenerateMessage(userId, second.assistantMessageId)
          : await service.editUserMessage(userId, second.userMessageId, "请联网搜索最新的API说明");
      const reader = response.getReader();
      await started;
      await reader.cancel();
      expect(held.signal?.aborted).toBe(true);
      expect(requests.length).toBe(modelCount);
      retrievalHold = undefined;
    }
    // A scoped preparation Stop aborts retrieval while returning persisted ids for the stopped question.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = { entered, signal: undefined as AbortSignal | undefined };
    retrievalHold = held;
    const preparationToken = crypto.randomUUID();
    const pendingPreparation = service.prepareChatForSidecar(userId, {
      conversationId,
      preparationToken,
      content: "请联网搜索最新API动态",
    });
    await started;
    await service.stopChatPreparation(userId, conversationId, preparationToken);
    const stoppedPreparation = await pendingPreparation;
    expect(stoppedPreparation.preparationStopped).toBe(true);
    expect(held.signal?.aborted).toBe(true);
    retrievalHold = undefined;
    await service.completeChatFromSidecar(userId, {
      conversationId,
      assistantMessageId: stoppedPreparation.assistantMessageId,
      saveToken: stoppedPreparation.saveToken,
      content: "",
      finishReason: "stopped",
    });
    expect(
      (await rows()).find((message) => message.id === stoppedPreparation.assistantMessageId)
        ?.finishReason,
    ).toBe("stopped");
    const earlyToken = crypto.randomUUID();
    await service.stopChatPreparation(userId, conversationId, earlyToken);
    const beforeEarly = nativeRequests + routerRequests;
    answerContextWindow = 256;
    const earlyStopped = await service.prepareChatForSidecar(userId, {
      conversationId,
      preparationToken: earlyToken,
      content: `请联网搜索最新说明${"x".repeat(100_000)}`,
    });
    answerContextWindow = undefined;
    expect(earlyStopped.messages).toEqual([]);
    expect(
      (await rows()).find((message) => message.id === earlyStopped.assistantMessageId)
        ?.finishReason,
    ).toBe("stopped");
    expect(earlyStopped.preparationStopped).toBe(true);
    expect(nativeRequests + routerRequests).toBe(beforeEarly);
    const staleToken = crypto.randomUUID();
    await service.stopChatPreparation(userId, conversationId, staleToken);
    const actualNow = Date.now;
    const beforeStale = nativeRequests + routerRequests;
    try {
      Date.now = () => actualNow() + 121_000;
      const staleStopped = await service.prepareChatForSidecar(userId, {
        conversationId,
        preparationToken: staleToken,
        stoppedBeforeStart: true,
        content: "请联网搜索，上传结束时已停止",
      });
      expect(staleStopped.preparationStopped).toBe(true);
      expect(nativeRequests + routerRequests).toBe(beforeStale);
    } finally {
      Date.now = actualNow;
    }
    const metadataStopped = await service.prepareChatForSidecar(userId, {
      conversationId,
      stoppedBeforeStart: true,
      content: "",
      stoppedAttachmentMeta: [
        { fileName: "unconfirmed-upload.txt", fileType: "text/plain", fileSize: 16 },
      ],
    });
    expect(metadataStopped.preparationStopped).toBe(true);
    const attachmentRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, metadataStopped.userMessageId));
    expect(attachmentRows.map((item) => item.fileName)).toEqual(["unconfirmed-upload.txt"]);
    expect(nativeRequests + routerRequests).toBe(beforeStale);
    await expect(
      service.stopChatPreparation("other-user", conversationId, earlyToken),
    ).rejects.toThrow();
  }
  await setSettingValue(userId, "liveSearch.provider", "tavily");
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
  await expect(setSettingValue(userId, "deepseek.nativeWebEnabled", "true")).rejects.toThrow(
    "deprecated_native_web_setting",
  );
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
  expect(httpTurn.nativeWeb).toBeUndefined();
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
      nativeIndependent: true,
      openRouterIndependent: true,
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
