import { expect, test } from "bun:test";
import { channels, settings, users } from "db";
import { and, eq } from "drizzle-orm";
import {
  DEEPSEEK_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_RUNTIME,
  readDeepSeekSearchRuntime,
} from "shared/deepseek-search";
import { TOOL_RUNTIME_SETTING } from "shared/tool-connection";
import { client, db } from "../db";
import { encrypt } from "../utils";
import { getSearchSettingsStatus, verifyAndActivateSearch } from "./searchSettingsService";
import { getSettingValues, setSettingValue } from "./settingsService";

test("saving a DeepSeek search connection encrypts it without switching the active source", async () => {
  const id = crypto.randomUUID();
  const trigger = `search_activation_${id.replaceAll("-", "")}`;
  await db.insert(users).values({
    id,
    username: "search",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await setSettingValue(id, "liveSearch.provider", "tavily");
    const config = {
      kind: "deepseek",
      source: "manual",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "search-relay-only",
    };
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, JSON.stringify(config));
    expect((await getSettingValues(id, ["liveSearch.provider"]))["liveSearch.provider"]).toBe(
      "tavily",
    );
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME])),
    ).toBeUndefined();
    expect(
      JSON.parse(
        (await getSettingValues(id, [DEEPSEEK_SEARCH_CONNECTION]))[DEEPSEEK_SEARCH_CONNECTION],
      ),
    ).toMatchObject(config);
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, DEEPSEEK_SEARCH_CONNECTION)));
    expect(row.value.startsWith("v2:")).toBe(true);
    expect(row.value.includes(config.apiKey)).toBe(false);
    await setSettingValue(id, "liveSearch.provider", "tavily");
    await expect(
      setSettingValue(
        id,
        DEEPSEEK_SEARCH_CONNECTION,
        JSON.stringify({ kind: "deepseek", source: "channel", channelId: "not-owned" }),
      ),
    ).rejects.toThrow();
    expect((await getSettingValues(id, ["liveSearch.provider"]))["liveSearch.provider"]).toBe(
      "tavily",
    );
    expect(
      JSON.parse(
        (await getSettingValues(id, [DEEPSEEK_SEARCH_CONNECTION]))[DEEPSEEK_SEARCH_CONNECTION],
      ).apiKey,
    ).toBe("search-relay-only");
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON settings WHEN NEW.user_id = '${id}' AND NEW.key = 'deepseek.searchConnection' BEGIN SELECT RAISE(ABORT, 'forced_save_failure'); END`,
    );
    await expect(
      setSettingValue(
        id,
        DEEPSEEK_SEARCH_CONNECTION,
        JSON.stringify({ ...config, apiKey: "new-unsaved-key" }),
      ),
    ).rejects.toThrow();
    expect(
      JSON.parse(
        (await getSettingValues(id, [DEEPSEEK_SEARCH_CONNECTION]))[DEEPSEEK_SEARCH_CONNECTION],
      ).apiKey,
    ).toBe("search-relay-only");
    expect((await getSettingValues(id, ["liveSearch.provider"]))["liveSearch.provider"]).toBe(
      "tavily",
    );
    await client.execute(`DROP TRIGGER ${trigger}`);
    await expect(
      setSettingValue(
        id,
        DEEPSEEK_SEARCH_CONNECTION,
        JSON.stringify({ ...config, kind: "openrouter", model: "test/model" }),
      ),
    ).rejects.toThrow();
    await expect(setSettingValue(id, DEEPSEEK_SEARCH_RUNTIME, "forged")).rejects.toThrow();
    expect(
      readDeepSeekSearchRuntime(await getSettingValues("other-user", [DEEPSEEK_SEARCH_RUNTIME])),
    ).toBeUndefined();
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

test("channel-backed DeepSeek search keeps the channel route without any model selection", async () => {
  const id = crypto.randomUUID(),
    channelId = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "search",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await db.insert(channels).values({
      id: channelId,
      userId: id,
      name: "Relay",
      provider: "openai",
      protocol: "openai",
      apiKey: encrypt("channel-search-only"),
      baseUrl: "https://relay.example.com/api/v1",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await setSettingValue(
      id,
      DEEPSEEK_SEARCH_CONNECTION,
      JSON.stringify({ kind: "deepseek", source: "channel", channelId }),
    );
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME])),
    ).toBeUndefined();
    expect(
      (
        await verifyAndActivateSearch(
          id,
          { provider: "deepseek", revision: (await getSearchSettingsStatus(id)).revision },
          {
            resolveHostname: async () => ["93.184.216.34"],
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  results: [{ title: "Synthetic docs", url: "https://example.com/docs" }],
                }),
              ),
          },
        )
      ).success,
    ).toBe(true);
    const connection = readDeepSeekSearchRuntime(
      await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]),
    );
    expect(connection?.baseUrl).toBe("https://relay.example.com/api/v1");
    expect(connection?.apiKey).toBe("channel-search-only");
    expect(connection?.model).toBeUndefined();
    await db.update(channels).set({ enabled: false }).where(eq(channels.id, channelId));
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME])),
    ).toBeUndefined();
    expect(
      readDeepSeekSearchRuntime({
        [TOOL_RUNTIME_SETTING]: JSON.stringify({
          kind: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "router-only",
          model: "test/model",
        }),
      }),
    ).toBeUndefined();
  } finally {
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(channels).where(eq(channels.id, channelId));
    await db.delete(users).where(eq(users.id, id));
  }
});
