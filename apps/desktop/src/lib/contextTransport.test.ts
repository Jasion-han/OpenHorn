import { expect, test } from "bun:test";
import type { ModelContextMetadata } from "shared/types";
import { createChatAdapter } from "./chatAdapter";
import { createServerApi } from "./serverApi";

const contextMetadata: ModelContextMetadata = {
  contextWindow: 262_144,
  maxInputTokens: 200_000,
  maxOutputTokens: 1024,
  source: "channel",
  fetchedAt: 1000,
};

test("credentials resolve the selected model including encoded aliases instead of the default", async () => {
  let requested = "";
  const fetcher = (async (url: string | URL | Request) => {
    requested = String(url);
    return Response.json({
      credentials: { modelId: "alias/large?1", contextWindow: 1_000_000, contextMetadata },
    });
  }) as typeof fetch;
  const api = createServerApi({ baseUrl: "http://127.0.0.1:3002", fetch: fetcher });
  const result = await api.channels.getCredentials("channel/1", "alias/large?1");
  expect(requested.endsWith("/channels/channel%2F1/credentials?modelId=alias%2Flarge%3F1")).toBe(
    true,
  );
  expect(result.credentials.contextWindow).toBe(1_000_000);
  expect(result.credentials.contextMetadata).toEqual(contextMetadata);
});

test("channel model capacity survives the server to desktop mapping", async () => {
  const at = "2026-11-02T00:00:00.000Z";
  const fetcher = (async () =>
    Response.json({
      channels: [
        {
          id: "channel",
          userId: "user",
          name: "fixture",
          provider: "openai",
          protocol: "openai",
          baseUrl: null,
          enabled: true,
          isDefault: true,
          createdAt: at,
          updatedAt: at,
          defaultModelId: "large",
          legacyModel: null,
          hasApiKey: true,
          models: [
            {
              id: "row",
              channelId: "channel",
              modelId: "large",
              displayName: "large",
              contextWindow: 1_000_000,
              contextMetadata,
              enabled: true,
              isDefault: true,
              createdAt: at,
              updatedAt: at,
            },
          ],
        },
      ],
    })) as typeof fetch;
  const adapter = createChatAdapter(
    createServerApi({ baseUrl: "http://127.0.0.1:3002", fetch: fetcher }),
  );
  const channels = await adapter.listChannels();
  expect(channels[0]?.models[0]?.contextWindow).toBe(1_000_000);
  expect(channels[0]?.models[0]?.contextMetadata).toEqual(contextMetadata);
});

test("capacity refresh uses the non-destructive endpoint without sending a model update", async () => {
  let path = "";
  let method: string | undefined;
  let body: unknown;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    path = String(url);
    method = init?.method;
    body = init?.body;
    return Response.json({ success: true, models: [], updated: 0 });
  }) as typeof fetch;
  const api = createServerApi({ baseUrl: "http://127.0.0.1:3002", fetch: fetcher });
  await api.channels.refreshContext("channel/1");
  expect(path.endsWith("/channels/channel%2F1/context-capabilities")).toBe(true);
  expect(method).toBe("POST");
  expect(body).toBe(undefined);
});
