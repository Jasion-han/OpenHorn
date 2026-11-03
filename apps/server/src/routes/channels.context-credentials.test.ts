import { expect, mock, test } from "bun:test";
import { channelModels, channels, users } from "db";
import { eq } from "drizzle-orm";
import { resolveContextPolicy } from "shared/context-policy";
import type { ModelContextMetadata } from "shared/types";
import { db } from "../db";
import { listChannelModels } from "../services/channelService";
import {
  CONTEXT_METADATA_TTL_MS,
  resetContextDiscoveryCaches,
} from "../services/modelContextDiscovery";
import { encrypt } from "../utils";
import * as requestUserNamespace from "../utils/requestUser";

const realRequestUser = { ...requestUserNamespace };

async function fixture(
  currentWindow: number,
  run: (input: {
    routes: Awaited<typeof import("./channels")>["default"];
    userId: string;
    channelId: string;
    useForeignUser: () => void;
    metadataCalls: () => number;
  }) => Promise<void>,
) {
  const priorKey = process.env.ENCRYPTION_KEY;
  const priorFetch = globalThis.fetch;
  process.env.ENCRYPTION_KEY = "context-credentials-fixture-only-key";
  resetContextDiscoveryCaches();
  const userId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const now = new Date();
  let requestUserId = userId;
  let calls = 0;
  const stale: ModelContextMetadata = {
    contextWindow: 1_000_000,
    maxOutputTokens: 4096,
    source: "catalog",
    fetchedAt: Date.now() - CONTEXT_METADATA_TTL_MS - 1,
  };
  try {
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.local`,
      username: "context-credentials",
      passwordHash: "x",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channels).values({
      id: channelId,
      userId,
      name: "ACP context credentials",
      provider: "fixture",
      protocol: "acp",
      apiKey: encrypt(JSON.stringify({ command: "fixture-acp" })),
      model: "saved-model",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channelModels).values(
      [
        { modelId: "saved-model", enabled: true, isDefault: true },
        { modelId: "disabled-model", enabled: false, isDefault: false },
      ].map((model) => ({
        ...model,
        id: crypto.randomUUID(),
        channelId,
        displayName: model.modelId,
        contextWindow: 1_000_000,
        contextMetadata: JSON.stringify(stale),
        createdAt: now,
        updatedAt: now,
      })),
    );
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("models.dev");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      calls++;
      return Response.json({
        "fixture/saved-model": {
          id: "saved-model",
          limit: { context: currentWindow, output: 1024 },
        },
        "fixture/live-only-model": {
          id: "live-only-model",
          limit: { context: 524288, output: 2048 },
        },
      });
    }) as typeof fetch;
    mock.module("../utils/requestUser", () => ({
      ...realRequestUser,
      requireUser: async (
        context: { set: (key: string, value: unknown) => void },
        next: () => Promise<void>,
      ) => {
        context.set("user", { id: requestUserId });
        return next();
      },
    }));
    const { default: routes } = await import(`./channels?credentials=${crypto.randomUUID()}`);
    await run({
      routes,
      userId,
      channelId,
      useForeignUser: () => {
        requestUserId = crypto.randomUUID();
      },
      metadataCalls: () => calls,
    });
  } finally {
    mock.module("../utils/requestUser", () => realRequestUser);
    globalThis.fetch = priorFetch;
    resetContextDiscoveryCaches();
    await db.delete(channelModels).where(eq(channelModels.channelId, channelId));
    await db.delete(channels).where(eq(channels.id, channelId));
    await db.delete(users).where(eq(users.id, userId));
    if (priorKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = priorKey;
  }
}

test("saved ACP model credentials return refreshed limits on the first request", async () => {
  for (const currentWindow of [131072, 2097152]) {
    await fixture(currentWindow, async ({ routes, userId, channelId, metadataCalls }) => {
      const response = await routes.request(`/${channelId}/credentials?modelId=saved-model`);
      expect(response.status).toBe(200);
      const { credentials } = (await response.json()) as {
        credentials: {
          modelId: string;
          contextWindow: number | null;
          contextMetadata: ModelContextMetadata | null;
        };
      };
      expect(credentials.modelId).toBe("saved-model");
      expect(credentials.contextWindow).toBe(1_000_000);
      expect(credentials.contextMetadata).toMatchObject({
        contextWindow: currentWindow,
        maxOutputTokens: 1024,
        source: "catalog",
      });
      const stored = (await listChannelModels(userId, channelId)).find(
        (model) => model.modelId === "saved-model",
      );
      expect(credentials.contextMetadata).toEqual(stored?.contextMetadata);
      expect(
        resolveContextPolicy({ model: credentials.modelId, ...credentials }).contextWindow,
      ).toBe(Math.min(1_000_000, currentWindow));
      expect(metadataCalls()).toBe(1);
    });
  }
});

test("live-only ACP credentials use exact catalog limits without inheriting saved overrides", async () => {
  await fixture(131072, async ({ routes, channelId, metadataCalls }) => {
    const response = await routes.request(`/${channelId}/credentials?modelId=live-only-model`);
    expect(response.status).toBe(200);
    const { credentials } = (await response.json()) as {
      credentials: {
        modelId: string;
        contextWindow: number | null;
        contextMetadata: ModelContextMetadata | null;
      };
    };
    expect(credentials.modelId).toBe("live-only-model");
    expect(credentials.contextWindow).toBe(null);
    expect(credentials.contextMetadata).toMatchObject({
      contextWindow: 524288,
      maxOutputTokens: 2048,
      source: "catalog",
    });
    expect(metadataCalls()).toBe(1);
  });
});

test("credentials reject disabled saved ACP models, unknown HTTP models and foreign channels", async () => {
  await fixture(131072, async ({ routes, channelId, useForeignUser, metadataCalls }) => {
    const disabled = await routes.request(`/${channelId}/credentials?modelId=disabled-model`);
    expect(disabled.status).toBe(400);
    expect(metadataCalls()).toBe(0);
    await db.update(channels).set({ protocol: "openai" }).where(eq(channels.id, channelId));
    const unknown = await routes.request(`/${channelId}/credentials?modelId=unknown-http-model`);
    expect(unknown.status).toBe(400);
    expect(metadataCalls()).toBe(0);
    useForeignUser();
    const foreign = await routes.request(`/${channelId}/credentials?modelId=saved-model`);
    expect(foreign.status).toBe(404);
    expect((await foreign.text()).includes("fixture-acp")).toBe(false);
    expect(metadataCalls()).toBe(0);
  });
});
