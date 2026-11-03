import { expect, mock, test } from "bun:test";
import { channelModels, channels, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { resolveContextPolicy } from "shared/context-policy";
import { db } from "../db";
import { encrypt } from "../utils";
import * as requestUserNamespace from "../utils/requestUser";
import {
  createChannel,
  fetchChannelModels,
  getResolvedChannelById,
  listChannelModels,
  refreshChannelContextCapabilities,
  updateChannel,
  updateChannelModels,
} from "./channelService";
import { prepareChatForSidecar, sendMessage } from "./messageService";
import { CONTEXT_METADATA_TTL_MS, resetContextDiscoveryCaches } from "./modelContextDiscovery";

const realRequestUser = { ...requestUserNamespace };

async function fixture(
  run: (ids: { userId: string; channelId: string; conversationId: string }) => Promise<void>,
) {
  const priorKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "context-discovery-fixture-only-key";
  const userId = crypto.randomUUID(),
    channelId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
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
      name: "Discovery",
      provider: "fixture",
      protocol: "openai",
      apiKey: encrypt("fixture-provider-secret"),
      baseUrl: "https://fixture.models/v1",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    // Construct the pre-existing roster directly; calling Add here would run
    // discovery before each test installs its controlled metadata transport.
    await db.insert(channelModels).values(
      [
        { modelId: "small-fixture", isDefault: true, contextWindow: 16384 },
        { modelId: "catalog-model" },
        { modelId: "vendor/alias-limit" },
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
      modelId: "catalog-model",
      title: "Discovery",
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

async function withFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const prior = globalThis.fetch;
  resetContextDiscoveryCaches();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(
      new URL(input instanceof Request ? input.url : String(input)),
      init,
    )) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = prior;
    resetContextDiscoveryCaches();
  }
}
const withoutMetadata = (models: Awaited<ReturnType<typeof listChannelModels>>) =>
  models.map(({ contextMetadata: _metadata, ...model }) => model);

test("manual additions return persisted channel capacities without a refresh or first run", async () => {
  await fixture(async ({ userId, channelId }) => {
    await withFetch(
      (url) =>
        url.hostname === "models.dev"
          ? Response.json({})
          : Response.json({
              data: [
                {
                  id: "future-vendor-model",
                  context_length: 524288,
                  max_input_tokens: 450000,
                  max_output_tokens: 8192,
                },
              ],
            }),
      async () => {
        const before = await listChannelModels(userId, channelId);
        const added = await updateChannelModels(userId, channelId, {
          models: [...before, { modelId: "future-vendor-model", contextWindow: 128000 }],
        });
        const model = added.find((item) => item.modelId === "future-vendor-model");
        expect(model?.contextMetadata).toMatchObject({
          contextWindow: 524288,
          maxInputTokens: 450000,
          maxOutputTokens: 8192,
          source: "channel",
        });
        expect(model?.contextWindow).toBe(128000);
        expect(model?.isDefault).toBe(false);
        expect(
          added
            .filter((item) => item.modelId !== "future-vendor-model")
            .map((item) => item.modelId),
        ).toEqual(before.map((item) => item.modelId));
        expect(
          (await listChannelModels(userId, channelId)).find(
            (item) => item.modelId === "future-vendor-model",
          )?.contextMetadata,
        ).toEqual(model?.contextMetadata);
      },
    );
  });
});

test("manual additions use the exact catalog when the channel lists IDs only", async () => {
  await fixture(async ({ userId, channelId }) => {
    await withFetch(
      (url) =>
        url.hostname === "models.dev"
          ? Response.json({
              "vendor/new-catalog-model": {
                id: "new-catalog-model",
                limit: { context: 1048576, input: 900000, output: 32768 },
              },
            })
          : Response.json({ data: [{ id: "new-catalog-model" }] }),
      async () => {
        const added = await updateChannelModels(userId, channelId, {
          models: [
            ...(await listChannelModels(userId, channelId)),
            { modelId: "new-catalog-model" },
          ],
        });
        expect(
          added.find((item) => item.modelId === "new-catalog-model")?.contextMetadata,
        ).toMatchObject({ contextWindow: 1048576, maxInputTokens: 900000, source: "catalog" });
      },
    );
  });
});

test("metadata outage cannot undo a newly saved manual model or invent its capacity", async () => {
  await fixture(async ({ userId, channelId }) => {
    await withFetch(
      () => {
        throw new Error("offline fixture");
      },
      async () => {
        const models = await updateChannelModels(userId, channelId, {
          models: [
            ...(await listChannelModels(userId, channelId)),
            { modelId: "unpublished-alias", contextWindow: 1000000 },
          ],
        });
        const added = models.find((item) => item.modelId === "unpublished-alias");
        expect(added?.contextMetadata).toBe(null);
        expect(added?.contextWindow).toBe(1000000);
        expect(added?.enabled).toBe(true);
      },
    );
  });
});

test("a new channel's automatic model synchronization includes independent input and output reports", async () => {
  await fixture(async ({ userId }) => {
    let createdId: string | undefined;
    try {
      await withFetch(
        (url) =>
          url.hostname === "models.dev"
            ? Response.json({})
            : Response.json({
                models: [
                  {
                    name: "models/future-google-model",
                    inputTokenLimit: 2097152,
                    outputTokenLimit: 65536,
                    supportedGenerationMethods: ["generateContent"],
                  },
                ],
              }),
        async () => {
          const created = await createChannel(userId, {
            name: "Onboarding fixture",
            provider: "google",
            protocol: "google",
            apiKey: "fixture",
            baseUrl: "https://new-channel.models",
            isDefault: false,
          });
          createdId = created.id;
          const synced = await fetchChannelModels(userId, created.id);
          expect(synced.success).toBe(true);
          expect(synced.models[0]?.modelId).toBe("future-google-model");
          expect(synced.models[0]?.contextMetadata).toMatchObject({
            contextWindow: 2097152,
            maxInputTokens: 2097152,
            maxOutputTokens: 65536,
            inputLimitOnly: true,
            source: "channel",
          });
        },
      );
    } finally {
      if (createdId) {
        await db.delete(channelModels).where(eq(channelModels.channelId, createdId));
        await db.delete(channels).where(eq(channels.id, createdId));
      }
    }
  });
});

test("a manually added OpenRouter alias is queried before returning without reconciling the model list", async () => {
  await fixture(async ({ userId, channelId }) => {
    await updateChannel(userId, channelId, { baseUrl: "https://openrouter.ai/api/v1" });
    let details = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") return Response.json({});
        if (url.pathname.endsWith("/endpoints")) {
          details++;
          return Response.json({
            data: {
              endpoints: [
                {
                  context_length: 1000000,
                  max_prompt_tokens: 850000,
                  max_completion_tokens: 16384,
                },
              ],
            },
          });
        }
        return Response.json({ data: [] });
      },
      async () => {
        const before = await listChannelModels(userId, channelId);
        const added = await updateChannelModels(userId, channelId, {
          models: [...before, { modelId: "vendor/onboarding-alias" }],
        });
        expect(details).toBe(1);
        expect(added).toHaveLength(before.length + 1);
        expect(
          added.find((model) => model.modelId === "vendor/onboarding-alias")?.contextMetadata,
        ).toMatchObject({ contextWindow: 1000000, maxInputTokens: 850000, source: "channel" });
      },
    );
  });
});

test("disabled new models are discovered, while toggles, manual limits and removals do not repeat discovery", async () => {
  await fixture(async ({ userId, channelId }) => {
    let requests = 0;
    await withFetch(
      (url) => {
        requests++;
        return url.hostname === "models.dev"
          ? Response.json({})
          : Response.json({ data: [{ id: "disabled-future-model", context_length: 65536 }] });
      },
      async () => {
        const before = await listChannelModels(userId, channelId);
        const added = await updateChannelModels(userId, channelId, {
          models: [...before, { modelId: "disabled-future-model", enabled: false }],
        });
        expect(added.find((model) => model.modelId === "disabled-future-model")).toMatchObject({
          enabled: false,
          contextMetadata: { contextWindow: 65536, source: "channel" },
        });
        const once = requests;
        await updateChannelModels(userId, channelId, {
          models: added.map((model) =>
            model.modelId === "disabled-future-model"
              ? { ...model, enabled: true, contextWindow: 32768 }
              : model,
          ),
        });
        expect(requests).toBe(once);
        const removed = await updateChannelModels(userId, channelId, { models: before });
        expect(requests).toBe(once);
        expect(removed).toHaveLength(before.length);
      },
    );
  });
});

test("metadata-only refresh never reconciles models, defaults, enabled flags or manual overrides", async () => {
  await fixture(async ({ userId, channelId }) => {
    const before = await listChannelModels(userId, channelId);
    await withFetch(
      (url, init) => {
        const headers = new Headers(init?.headers);
        if (url.hostname === "models.dev") {
          expect(headers.has("authorization")).toBe(false);
          return Response.json({});
        }
        expect(headers.get("authorization")).toBe("Bearer fixture-provider-secret");
        return Response.json({
          data: [
            { id: "small-fixture", context_length: 8192, max_output_tokens: 128 },
            { id: "unlisted-model", context_length: 65536 },
          ],
        });
      },
      async () => {
        const result = await refreshChannelContextCapabilities(userId, channelId, { force: true });
        expect(result.success).toBe(true);
        expect(result.updated).toBe(1);
        expect(withoutMetadata(result.models)).toEqual(withoutMetadata(before));
        const model = result.models.find((model) => model.modelId === "small-fixture");
        expect(resolveContextPolicy({ model: "small-fixture", ...model }).maxOutputTokens).toBe(
          128,
        );
        expect(resolveContextPolicy({ model: "small-fixture", ...model }).contextWindow).toBe(8192);
      },
    );
  });
});

test("lazy catalog fallback is cached and transports automatic capacities beyond the manual RPC range", async () => {
  await fixture(async ({ userId, channelId, conversationId }) => {
    let own = 0,
      publicCalls = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") {
          publicCalls++;
          return Response.json({
            "vendor/catalog-model": {
              id: "catalog-model",
              limit: { context: 2_097_152, input: 2_000_000, output: 512 },
            },
          });
        }
        own++;
        return Response.json({ data: [] });
      },
      async () => {
        const first = await getResolvedChannelById(userId, channelId, "catalog-model");
        const again = await getResolvedChannelById(userId, channelId, "catalog-model");
        expect(first?.contextMetadata?.source).toBe("catalog");
        expect(again?.contextMetadata?.contextWindow).toBe(2_097_152);
        expect(own).toBe(1);
        expect(publicCalls).toBe(1);
        const prepared = await prepareChatForSidecar(userId, {
          conversationId,
          content: "keep this request",
        });
        expect(prepared.contextWindow).toBe(null);
        expect(prepared.contextMetadata?.contextWindow).toBe(2_097_152);
        expect(resolveContextPolicy(prepared).maxOutputTokens).toBe(512);
        const current = await listChannelModels(userId, channelId);
        await updateChannelModels(userId, channelId, {
          models: current.map((model) => ({
            ...model,
            ...(model.modelId === "catalog-model" ? { contextWindow: 8192 } : {}),
          })),
        });
        expect(
          resolveContextPolicy({
            model: "catalog-model",
            ...(await getResolvedChannelById(userId, channelId, "catalog-model")),
          }).contextWindow,
        ).toBe(8192);
        expect(own).toBe(1);
      },
    );
  });
});

test("partial channel updates retain earlier input/output ceilings and failed refresh preserves last good data", async () => {
  await fixture(async ({ userId, channelId }) => {
    let phase = 0,
      own = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") return Response.json({});
        own++;
        if (phase === 2) throw new Error("offline");
        return Response.json({
          data: [
            {
              id: "vendor/alias-limit",
              context_length: 128_000,
              ...(phase === 0 ? { max_input_tokens: 32768, max_output_tokens: 1024 } : {}),
            },
          ],
        });
      },
      async () => {
        await refreshChannelContextCapabilities(userId, channelId, { force: true });
        phase = 1;
        const second = await refreshChannelContextCapabilities(userId, channelId, { force: true });
        const alias = second.models.find((model) => model.modelId === "vendor/alias-limit");
        expect(alias?.contextMetadata?.maxInputTokens).toBe(32768);
        expect(alias?.contextMetadata?.maxOutputTokens).toBe(1024);
        phase = 2;
        const cached = await refreshChannelContextCapabilities(userId, channelId, { force: true });
        expect(cached.success).toBe(true);
        expect(Boolean(cached.error)).toBe(true);
        expect(
          cached.models.find((model) => model.modelId === "vendor/alias-limit")?.contextMetadata
            ?.maxInputTokens,
        ).toBe(32768);
        const now = Date.now;
        const later = now() + 60_001;
        const callsBeforeRetry = own;
        Date.now = () => later;
        try {
          await refreshChannelContextCapabilities(userId, channelId);
          expect(own).toBe(callsBeforeRetry + 1);
        } finally {
          Date.now = now;
        }
        if (!alias) throw new Error("Expected alias fixture");
        const stale = {
          ...alias?.contextMetadata,
          fetchedAt: Date.now() - CONTEXT_METADATA_TTL_MS - 1,
        };
        await db
          .update(channelModels)
          .set({ contextMetadata: JSON.stringify(stale) })
          .where(eq(channelModels.id, alias.id));
        phase = 2;
        const failed = await refreshChannelContextCapabilities(userId, channelId, { force: true });
        expect(failed.success).toBe(false);
        expect(
          failed.models.find((model) => model.modelId === "vendor/alias-limit")?.contextMetadata,
        ).toEqual(stale);
        const calls = own;
        await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
        expect(own).toBe(calls);
      },
    );
  });
});

test("new model IDs invalidate the successful channel refresh cache; numeric override changes do not", async () => {
  await fixture(async ({ userId, channelId }) => {
    let own = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") return Response.json({});
        own++;
        return Response.json({ data: [{ id: "new-live", context_length: 256_000 }] });
      },
      async () => {
        await refreshChannelContextCapabilities(userId, channelId, { force: true });
        const existing = await listChannelModels(userId, channelId);
        await updateChannelModels(userId, channelId, {
          models: [...existing, { modelId: "new-live" }],
        });
        const fresh = await getResolvedChannelById(userId, channelId, "new-live");
        expect(fresh?.contextMetadata?.contextWindow).toBe(256_000);
        expect(own).toBe(2);
        await updateChannelModels(userId, channelId, {
          models: (await listChannelModels(userId, channelId)).map((model) => ({
            ...model,
            contextWindow: model.modelId === "catalog-model" ? 64000 : model.contextWindow,
          })),
        });
        await getResolvedChannelById(userId, channelId, "catalog-model");
        expect(own).toBe(2);
      },
    );
  });
});

test("metadata refresh and regular directory sync cannot repopulate metadata from an old endpoint", async () => {
  for (const operation of ["metadata", "sync"] as const) {
    await fixture(async ({ userId, channelId }) => {
      let release!: (response: Response) => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      await withFetch(
        (url) => {
          if (url.hostname === "models.dev") return Response.json({});
          started();
          return response;
        },
        async () => {
          const before = await listChannelModels(userId, channelId);
          const pending =
            operation === "metadata"
              ? refreshChannelContextCapabilities(userId, channelId, { force: true })
              : fetchChannelModels(userId, channelId);
          await waiting;
          await updateChannel(userId, channelId, {
            baseUrl: "https://new-fixture.models/v1",
            apiKey: "replacement-fixture-secret",
          });
          release(
            Response.json({ data: [{ id: "old-endpoint-model", context_length: 2_000_000 }] }),
          );
          expect((await pending).success).toBe(false);
          const after = await listChannelModels(userId, channelId);
          expect(after.map((model) => model.modelId)).toEqual(before.map((model) => model.modelId));
          expect(after.every((model) => model.contextMetadata === null)).toBe(true);
        },
      );
    });
  }
});

test("fresh OpenRouter list metadata receives one selected endpoint enrichment, with exact low input ceiling", async () => {
  await fixture(async ({ userId, channelId }) => {
    await db
      .update(channels)
      .set({ baseUrl: "https://openrouter.ai/api/v1" })
      .where(eq(channels.id, channelId));
    let details = 0,
      directory = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") return Response.json({});
        if (url.pathname.endsWith("/endpoints")) {
          details++;
          return Response.json({
            data: {
              endpoints: [
                { context_length: 128000, max_prompt_tokens: 32768, max_completion_tokens: 1024 },
              ],
            },
          });
        }
        directory++;
        return Response.json({ data: [{ id: "vendor/alias-limit", context_length: 128000 }] });
      },
      async () => {
        await refreshChannelContextCapabilities(userId, channelId, { force: true });
        const selected = await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
        expect(selected?.contextMetadata?.maxInputTokens).toBe(32768);
        expect(selected?.contextMetadata?.maxOutputTokens).toBe(1024);
        await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
        expect(details).toBe(1);
        expect(directory).toBe(1);
      },
    );
  });
});

test("future metadata timestamps do not suppress automatic discovery", async () => {
  await fixture(async ({ userId, channelId }) => {
    const target = (await listChannelModels(userId, channelId)).find(
      (model) => model.modelId === "catalog-model",
    );
    if (!target) throw new Error("Expected catalog fixture");
    await db
      .update(channelModels)
      .set({
        contextMetadata: JSON.stringify({
          contextWindow: 32768,
          source: "channel",
          fetchedAt: Date.now() + 10_000_000,
        }),
      })
      .where(eq(channelModels.id, target.id));
    let calls = 0;
    await withFetch(
      (url) => {
        if (url.hostname === "models.dev") return Response.json({});
        calls++;
        return Response.json({ data: [{ id: "catalog-model", context_length: 65536 }] });
      },
      async () => {
        expect(
          (await getResolvedChannelById(userId, channelId, "catalog-model"))?.contextMetadata
            ?.contextWindow,
        ).toBe(65536);
        expect(calls).toBe(1);
      },
    );
  });
});

test("metadata-only HTTP refresh enforces channel ownership before any fetch", async () => {
  await fixture(async ({ userId, channelId }) => {
    let requester = "foreign-user",
      calls = 0;
    mock.module("../utils/requestUser", () => ({
      ...realRequestUser,
      requireUser: async (
        context: { set: (key: string, value: unknown) => void },
        next: () => Promise<void>,
      ) => {
        context.set("user", { id: requester });
        return next();
      },
    }));
    try {
      const { default: routes } = await import(
        `../routes/channels?metadata=${crypto.randomUUID()}`
      );
      await withFetch(
        () => {
          calls++;
          return Response.json({ data: [] });
        },
        async () => {
          expect(
            (await routes.request(`/${channelId}/context-capabilities`, { method: "POST" })).status,
          ).toBe(404);
          expect(calls).toBe(0);
          requester = userId;
          const owned = await routes.request(`/${channelId}/context-capabilities`, {
            method: "POST",
          });
          expect(owned.status).toBe(200);
          const body = (await owned.json()) as {
            success: boolean;
            models: unknown[];
            updated: number;
          };
          expect(body.models.length).toBe(3);
          expect(body.updated).toBe(0);
        },
      );
    } finally {
      mock.module("../utils/requestUser", () => realRequestUser);
    }
  });
});

test("CLI-only channels use the public catalog without transmitting local credentials", async () => {
  await fixture(async ({ userId, channelId }) => {
    await db
      .update(channels)
      .set({ apiKey: encrypt("__cli_oauth__:fixture_cli") })
      .where(eq(channels.id, channelId));
    let calls = 0;
    await withFetch(
      (url, init) => {
        calls++;
        expect(url.hostname).toBe("models.dev");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json({
          "vendor/catalog-model": {
            id: "catalog-model",
            limit: { context: 16_777_216, output: 2048 },
          },
        });
      },
      async () => {
        const result = await refreshChannelContextCapabilities(userId, channelId, { force: true });
        expect(
          result.models.find((model) => model.modelId === "catalog-model")?.contextMetadata
            ?.contextWindow,
        ).toBe(16_777_216);
        expect(calls).toBe(1);
      },
    );
  });
});

test("discovered low output ceilings reach the actual Chat adapter request", async () => {
  await fixture(async ({ userId, channelId, conversationId }) => {
    const target = (await listChannelModels(userId, channelId)).find(
      (model) => model.modelId === "catalog-model",
    );
    if (!target) throw new Error("Missing fixture model");
    await db
      .update(channelModels)
      .set({
        contextMetadata: JSON.stringify({
          contextWindow: 65536,
          maxOutputTokens: 128,
          source: "channel",
          fetchedAt: Date.now(),
        }),
      })
      .where(eq(channelModels.id, target.id));
    const caps: number[] = [];
    await withFetch(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          stream?: boolean;
          max_tokens?: number;
        };
        if (!body.stream)
          return Response.json({ choices: [{ message: { content: "direct_model" } }] });
        caps.push(body.max_tokens ?? 0);
        return new Response(
          'data: {"choices":[{"delta":{"content":"LOW-OUTPUT-OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      async () => {
        const result = await sendMessage(userId, {
          conversationId,
          content: "Summarize this fixed text without web search: example",
        });
        expect(result.assistantMessage.content).toBe("LOW-OUTPUT-OK");
        expect(caps).toEqual([128]);
      },
    );
  });
});

test("OpenRouter metadata-only refresh uses its public directory independently of empty or invalid inference auth", async () => {
  for (const apiKey of ["", "not-valid-encrypted-inference-auth", "__cli_oauth__:fixture_cli"]) {
    await fixture(async ({ userId, channelId }) => {
      await db
        .update(channels)
        .set({ baseUrl: "https://openrouter.ai/api/v1", apiKey })
        .where(eq(channels.id, channelId));
      const before = await listChannelModels(userId, channelId);
      let directories = 0;
      await withFetch(
        (url, init) => {
          const headers = new Headers(init?.headers);
          expect(headers.has("authorization")).toBe(false);
          expect(headers.has("x-api-key")).toBe(false);
          if (url.hostname === "models.dev") return Response.json({});
          expect(url.href).toBe("https://openrouter.ai/api/v1/models");
          directories++;
          return Response.json({
            data: [
              {
                id: "catalog-model",
                context_length: 128_000,
                top_provider: { max_completion_tokens: 8192 },
              },
            ],
          });
        },
        async () => {
          const result = await refreshChannelContextCapabilities(userId, channelId, {
            force: true,
          });
          expect(result.success).toBe(true);
          expect(
            result.models.find((model) => model.modelId === "catalog-model")?.contextMetadata
              ?.contextWindow,
          ).toBe(128_000);
          expect(withoutMetadata(result.models)).toEqual(withoutMetadata(before));
          expect(directories).toBe(1);
        },
      );
    });
  }
});

test("a cold OpenRouter resolution starts directory, catalog and selected detail concurrently then caches the result", async () => {
  await fixture(async ({ userId, channelId }) => {
    await db
      .update(channels)
      .set({ baseUrl: "https://openrouter.ai/api/v1" })
      .where(eq(channels.id, channelId));
    const pendingResponses: Array<{ url: URL; resolve: (response: Response) => void }> = [];
    let allStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    await withFetch(
      (url) =>
        new Promise<Response>((resolve) => {
          pendingResponses.push({ url, resolve });
          if (pendingResponses.length === 3) allStarted?.();
        }),
      async () => {
        const resolving = getResolvedChannelById(userId, channelId, "vendor/alias-limit");
        await started;
        expect(pendingResponses.length).toBe(3);
        for (const pending of pendingResponses) {
          pending.resolve(
            Response.json(
              pending.url.hostname === "models.dev"
                ? {}
                : pending.url.pathname.endsWith("/endpoints")
                  ? {
                      data: {
                        endpoints: [
                          {
                            context_length: 128000,
                            max_prompt_tokens: 32768,
                            max_completion_tokens: 1024,
                          },
                        ],
                      },
                    }
                  : { data: [{ id: "vendor/alias-limit", context_length: 128000 }] },
            ),
          );
        }
        expect((await resolving)?.contextMetadata?.maxInputTokens).toBe(32768);
        await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
        expect(pendingResponses.length).toBe(3);
      },
    );
  });
});

test("a warm OpenRouter channel still discovers a selected unlisted alias and backs off missing endpoints", async () => {
  for (const endpointStatus of [200, 404]) {
    await fixture(async ({ userId, channelId }) => {
      await db
        .update(channels)
        .set({ baseUrl: "https://openrouter.ai/api/v1" })
        .where(eq(channels.id, channelId));
      let directories = 0,
        catalogs = 0,
        details = 0;
      await withFetch(
        (url) => {
          if (url.hostname === "models.dev") {
            catalogs++;
            return Response.json({});
          }
          if (url.pathname.endsWith("/endpoints")) {
            details++;
            expect(url.href).toBe(
              "https://openrouter.ai/api/v1/models/vendor/alias-limit/endpoints",
            );
            return endpointStatus === 404
              ? new Response("missing endpoint", { status: 404 })
              : Response.json({
                  data: {
                    endpoints: [
                      {
                        context_length: 128000,
                        max_prompt_tokens: 32768,
                        max_completion_tokens: 1024,
                      },
                    ],
                  },
                });
          }
          directories++;
          return Response.json({ data: [{ id: "small-fixture", context_length: 8192 }] });
        },
        async () => {
          const initial = await refreshChannelContextCapabilities(userId, channelId, {
            force: true,
          });
          expect(
            initial.models.find((model) => model.modelId === "vendor/alias-limit")?.contextMetadata,
          ).toBe(null);
          const selected = await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
          const persisted = (await listChannelModels(userId, channelId)).find(
            (model) => model.modelId === "vendor/alias-limit",
          );
          expect(selected?.contextMetadata?.maxInputTokens ?? null).toBe(
            endpointStatus === 200 ? 32768 : null,
          );
          expect(persisted?.contextMetadata?.maxInputTokens ?? null).toBe(
            endpointStatus === 200 ? 32768 : null,
          );
          await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
          expect(directories).toBe(1);
          expect(catalogs).toBe(1);
          expect(details).toBe(1);
          if (endpointStatus === 404) {
            const now = Date.now;
            const later = now() + 60_001;
            Date.now = () => later;
            try {
              await getResolvedChannelById(userId, channelId, "vendor/alias-limit");
            } finally {
              Date.now = now;
            }
            expect(details).toBe(2);
            expect(directories).toBe(1);
            expect(catalogs).toBe(1);
          }
        },
      );
    });
  }
});
