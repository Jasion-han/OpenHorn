import { expect, test } from "bun:test";
import { channelModels, channels, settings, users } from "db";
import { and, eq } from "drizzle-orm";
import {
  NATIVE_SEARCH_ACTIVE,
  NATIVE_SEARCH_CONFIG,
  NATIVE_SEARCH_MODEL,
  NATIVE_SEARCH_RUNTIME,
  readNativeSearchRuntime,
} from "shared/deepseek-native-search";
import { client, db } from "../db";
import { encrypt } from "../utils";
import {
  getSearchSettingsConfiguration,
  getSearchSettingsStatus,
  verifyAndActivateSearch,
} from "./searchSettingsService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "./settingsService";

const payload = () => ({
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
          text: "Synthetic search summary",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/docs",
              title: "Official docs fixture",
            },
          ],
        },
      ],
    },
  ],
});
const manual = (apiKey = "synthetic-native-key") => JSON.stringify({ source: "manual", apiKey });
async function fixture(run: (id: string) => Promise<void>) {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "native-search",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await run(id);
  } finally {
    await db.delete(settings).where(eq(settings.userId, id));
    const owned = await db.select().from(channels).where(eq(channels.userId, id));
    for (const channel of owned)
      await db.delete(channelModels).where(eq(channelModels.channelId, channel.id));
    await db.delete(channels).where(eq(channels.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
async function activate(id: string, fetchImpl = async () => Response.json(payload())) {
  return verifyAndActivateSearch(
    id,
    { provider: "deepseek-native", revision: (await getSearchSettingsStatus(id)).revision },
    { fetchImpl, resolveHostname: async () => ["93.184.216.34"] },
  );
}
async function channel(id: string, baseUrl: string, model = NATIVE_SEARCH_MODEL) {
  const channelId = crypto.randomUUID();
  await db.insert(channels).values({
    id: channelId,
    userId: id,
    name: `Native fixture ${channelId}`,
    protocol: "openai",
    provider: "deepseek",
    apiKey: encrypt("synthetic-channel-key"),
    baseUrl,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(channelModels).values({
    id: crypto.randomUUID(),
    channelId,
    modelId: model,
    displayName: model,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return channelId;
}

test("native candidate is encrypted and cannot activate or borrow another search key until verified", () =>
  fixture(async (id) => {
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual());
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
    expect(readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    await expect(setSettingValue(id, "liveSearch.provider", "deepseek-native")).rejects.toThrow(
      "search_verification_required",
    );
    const [stored] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, NATIVE_SEARCH_CONFIG)));
    expect(stored.value.startsWith("v2:")).toBe(true);
    expect(stored.value.includes("synthetic-native-key")).toBe(false);
    expect((await activate(id)).success).toBe(true);
    const status = await getSearchSettingsStatus(id);
    expect(status.effectiveProvider).toBe("deepseek-native");
    expect(status.verification).toBe("verified");
    expect(status.nativeConnection).toMatchObject({ source: "manual", model: NATIVE_SEARCH_MODEL });
    expect(
      readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("synthetic-native-key");
    expect(JSON.stringify(status).includes("synthetic-native-key")).toBe(false);
  }));

test("ordinary model answers are rejected and cannot replace the working source", () =>
  fixture(async (id) => {
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual());
    const result = await activate(id, async () =>
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I searched the web" }],
          },
        ],
      }),
    );
    expect(result).toEqual({ success: false, errorCode: "search_not_executed" });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("native credential choices include only owned official channels with an enabled supported model", () =>
  fixture(async (id) => {
    const official = await channel(id, "https://api.deepseek.com/v1");
    const relay = await channel(id, "https://relay.example.com/v1");
    await channel(id, "https://api.deepseek.com/v1", "deepseek-flash");
    const snapshot = await getSearchSettingsConfiguration(id);
    expect(snapshot.nativeChannels?.map((item) => item.channelId)).toEqual([official]);
    await expect(
      setSettingValue(
        id,
        NATIVE_SEARCH_CONFIG,
        JSON.stringify({ source: "channel", channelId: relay }),
      ),
    ).rejects.toThrow();
    await expect(
      setSettingValue(
        "foreign-user",
        NATIVE_SEARCH_CONFIG,
        JSON.stringify({ source: "channel", channelId: official }),
      ),
    ).rejects.toThrow();
    await setSettingValue(
      id,
      NATIVE_SEARCH_CONFIG,
      JSON.stringify({ source: "channel", channelId: official }),
    );
    expect(
      (await getSettingValues(id, [NATIVE_SEARCH_CONFIG]))[NATIVE_SEARCH_CONFIG].includes("apiKey"),
    ).toBe(false);
    expect((await activate(id)).success).toBe(true);
    expect((await getSearchSettingsStatus(id)).nativeConnection?.channelName).toBe(
      `Native fixture ${official}`,
    );
    await db
      .update(channels)
      .set({ apiKey: encrypt("changed-channel-key") })
      .where(eq(channels.id, official));
    expect(readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
    expect((await activate(id)).success).toBe(true);
    await db
      .update(channelModels)
      .set({ enabled: false })
      .where(eq(channelModels.channelId, official));
    expect(readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    expect((await getSearchSettingsConfiguration(id)).nativeChannels).toEqual([]);
  }));

test("saving or deleting a replacement cannot change the verified native connection", () =>
  fixture(async (id) => {
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual("working-key"));
    await activate(id);
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual("unverified-replacement"));
    expect((await getSearchSettingsStatus(id)).pendingProviders).toEqual(["deepseek-native"]);
    expect(
      readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("working-key");
    await deleteSettingValue(id, NATIVE_SEARCH_CONFIG);
    expect(
      readNativeSearchRuntime(await getSettingValues(id, [NATIVE_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("working-key");
    await expect(setSettingValue(id, NATIVE_SEARCH_ACTIVE, manual())).rejects.toThrow(
      "read_only_setting",
    );
    await expect(deleteSettingValue(id, NATIVE_SEARCH_RUNTIME)).rejects.toThrow(
      "read_only_setting",
    );
  }));

test("changing the native candidate during a probe rejects late activation", () =>
  fixture(async (id) => {
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual());
    const result = await activate(id, async () => {
      await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual("changed-during-probe"));
      return Response.json(payload());
    });
    expect(result).toEqual({ success: false, errorCode: "search_configuration_changed" });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("native activation transaction rolls back source, active credentials and verification together", () =>
  fixture(async (id) => {
    await setSettingValue(id, NATIVE_SEARCH_CONFIG, manual());
    const trigger = `native_activation_${id.replaceAll("-", "")}`;
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON settings WHEN NEW.user_id = '${id}' AND NEW.key = 'liveSearch.verification.deepseek-native' BEGIN SELECT RAISE(ABORT, 'forced_native_activation_failure'); END`,
    );
    try {
      await expect(activate(id)).rejects.toThrow();
      expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
      expect(Object.keys(await getSettingValues(id, [NATIVE_SEARCH_ACTIVE]))).toHaveLength(0);
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }
  }));
