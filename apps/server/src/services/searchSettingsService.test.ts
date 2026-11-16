import { expect, test } from "bun:test";
import { channels, settings, users } from "db";
import { and, eq } from "drizzle-orm";
import {
  DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_RUNTIME,
  readDeepSeekSearchRuntime,
} from "shared/deepseek-search";
import { TAVILY_SEARCH_RUNTIME_KEY } from "shared/search";
import { LEGACY_TOOL_KEY } from "shared/tool-connection";
import { client, db } from "../db";
import { encrypt } from "../utils";
import { buildLinkContext, buildSearchContext, SEARCH_SETTINGS_KEYS } from "./searchService";
import {
  getSearchSettingsConfiguration,
  getSearchSettingsStatus,
  verifyAndActivateSearch,
} from "./searchSettingsService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "./settingsService";

const config = (key = "synthetic-search-key") =>
  JSON.stringify({
    kind: "deepseek",
    source: "manual",
    baseUrl: "https://relay.example.com/v1",
    apiKey: key,
  });
const response = () =>
  new Response(
    JSON.stringify({
      results: [
        {
          title: "Synthetic official docs",
          url: "https://example.com/docs",
          summary: "Synthetic evidence",
        },
      ],
    }),
  );
const publicDns = async () => ["93.184.216.34"];
async function fixture(run: (id: string) => Promise<void>) {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "search",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await run(id);
  } finally {
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(channels).where(eq(channels.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
async function legacyTavily(id: string) {
  await db.insert(settings).values({
    id: crypto.randomUUID(),
    userId: id,
    key: "liveSearch.tavilyApiKey",
    value: "synthetic-tavily",
    updatedAt: new Date(),
  });
}
async function activate(
  id: string,
  provider: "tavily" | "deepseek" | "duckduckgo" = "deepseek",
  fetchImpl = async () => response(),
) {
  return verifyAndActivateSearch(
    id,
    { provider, revision: (await getSearchSettingsStatus(id)).revision },
    { fetchImpl, resolveHostname: publicDns },
  );
}

test("legacy Tavily stays configured and visible before new verification records exist", () =>
  fixture(async (id) => {
    await legacyTavily(id);
    const status = await getSearchSettingsStatus(id);
    expect(status.configuredProviders).toEqual(["tavily"]);
    expect(status.availableProviders).toEqual([]);
    expect(status.verification).toBe("unverified");
  }));

test("explicit verification-only validates Tavily without switching or enabling the selected source", () =>
  fixture(async (id) => {
    await legacyTavily(id);
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await setSettingValue(id, "liveSearch.tavilyEnabled", "false");
    let calls = 0;
    const result = await verifyAndActivateSearch(
      id,
      { provider: "tavily", revision: (await getSearchSettingsStatus(id)).revision },
      {
        activate: false,
        fetchImpl: async () => {
          calls++;
          return Response.json({
            results: [
              { url: "https://example.com/docs", title: "Docs", content: "Retrieved text" },
            ],
          });
        },
      },
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(1);
    const status = await getSearchSettingsStatus(id);
    expect(status.effectiveProvider).toBe("duckduckgo");
    expect(status.availableProviders).toEqual(["tavily"]);
    expect(
      (await getSettingValues(id, ["liveSearch.tavilyEnabled"]))["liveSearch.tavilyEnabled"],
    ).toBe("false");
  }));

test("saving a candidate does not enable it; structured search verification enables one source", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.provider", "tavily");
    await legacyTavily(id);
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    const before = await getSearchSettingsStatus(id);
    expect(before.effectiveProvider).toBe("tavily");
    expect(before.verification).toBe("unverified");
    let calls = 0;
    const result = await verifyAndActivateSearch(
      id,
      { provider: "deepseek", revision: before.revision },
      {
        resolveHostname: publicDns,
        fetchImpl: async (url, init) => {
          calls++;
          expect(String(url)).toBe("https://relay.example.com/v1/tools/search");
          expect(init?.redirect).toBe("error");
          expect(JSON.parse(String(init?.body)).count).toBe(1);
          expect((init?.headers as Record<string, string>).Authorization).toBe(
            "Bearer synthetic-search-key",
          );
          return response();
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.success).toBe(true);
    const status = await getSearchSettingsStatus(id);
    expect(status.effectiveProvider).toBe("deepseek");
    expect(status.verification).toBe("verified");
    expect(JSON.stringify(status).includes("synthetic-search-key")).toBe(false);
    const runtime = readDeepSeekSearchRuntime(
      await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]),
    );
    expect(runtime?.apiKey).toBe("synthetic-search-key");
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, DEEPSEEK_ACTIVE_SEARCH_CONNECTION)));
    expect(row.value.startsWith("v2:")).toBe(true);
  }));

for (const [name, makeResponse, errorCode] of [
  [
    "chat-only endpoint",
    () => new Response("not found", { status: 404 }),
    "search_endpoint_unsupported",
  ],
  ["invalid key", () => new Response("echo-key", { status: 401 }), "search_auth_failed"],
  ["rate limit", () => new Response("", { status: 429 }), "search_rate_limited"],
  [
    "model reply",
    () => new Response(JSON.stringify({ choices: [{ message: { content: "I searched" } }] })),
    "search_invalid_response",
  ],
  ["empty sources", () => new Response(JSON.stringify({ results: [] })), "search_no_results"],
  [
    "unsafe source",
    () => new Response(JSON.stringify({ results: [{ url: "http://127.0.0.1/private" }] })),
    "search_no_results",
  ],
] as const)
  test(`rejects ${name} without replacing Tavily`, () =>
    fixture(async (id) => {
      await legacyTavily(id);
      await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
      expect(await activate(id, "deepseek", async () => makeResponse())).toEqual({
        success: false,
        errorCode,
      });
      expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("tavily");
    }));

test("a saved replacement keeps the verified active DeepSeek connection until successful activation", () =>
  fixture(async (id) => {
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("first-key"));
    expect((await activate(id)).success).toBe(true);
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("replacement-key"));
    expect((await getSearchSettingsStatus(id)).verification).toBe("verified");
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("first-key");
    expect(
      (await activate(id, "deepseek", async () => new Response("", { status: 404 }))).success,
    ).toBe(false);
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("first-key");
    expect((await activate(id)).success).toBe(true);
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("replacement-key");
  }));

test("a source change during verification rejects late activation", () =>
  fixture(async (id) => {
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    const result = await activate(id, "deepseek", async () => {
      await setSettingValue(id, "liveSearch.provider", "duckduckgo");
      return response();
    });
    expect(result).toEqual({ success: false, errorCode: "search_configuration_changed" });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("a candidate key change during verification cannot inherit its predecessor's verification", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    const result = await activate(id, "deepseek", async () => {
      await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("changed-key"));
      return response();
    });
    expect(result).toEqual({ success: false, errorCode: "search_configuration_changed" });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
    await expect(setSettingValue(id, "liveSearch.provider", "deepseek")).rejects.toThrow(
      "search_verification_required",
    );
  }));

test("stale revisions and another user's configuration cannot initiate paid probes", () =>
  fixture(async (id) => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return response();
    };
    const old = await getSearchSettingsStatus(id);
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    expect(
      await verifyAndActivateSearch(
        id,
        { provider: "deepseek", revision: old.revision },
        { fetchImpl: probe },
      ),
    ).toEqual({ success: false, errorCode: "search_configuration_changed" });
    await fixture(async (other) => {
      expect(await activate(other, "deepseek", probe)).toEqual({
        success: false,
        errorCode: "search_not_configured",
      });
    });
    expect(calls).toBe(0);
    await expect(
      setSettingValue(id, "liveSearch.verification.deepseek", "forged"),
    ).rejects.toThrow();
    await expect(
      setSettingValue(id, DEEPSEEK_ACTIVE_SEARCH_CONNECTION, config()),
    ).rejects.toThrow();
  }));

test("channel credential changes invalidate their verified capability marker", () =>
  fixture(async (id) => {
    const channelId = crypto.randomUUID();
    await db.insert(channels).values({
      id: channelId,
      userId: id,
      name: "Legacy channel",
      provider: "openai",
      protocol: "openai",
      apiKey: encrypt("legacy-key"),
      baseUrl: "https://relay.example.com/v1",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await setSettingValue(
      id,
      DEEPSEEK_SEARCH_CONNECTION,
      JSON.stringify({ kind: "deepseek", source: "channel", channelId }),
    );
    expect((await activate(id)).success).toBe(true);
    await db
      .update(channels)
      .set({ apiKey: encrypt("rotated-key") })
      .where(eq(channels.id, channelId));
    expect((await getSearchSettingsStatus(id)).verification).toBe("unavailable");
    expect(readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    let calls = 0;
    const runtimeResult = await buildSearchContext({
      route: "web_search",
      prompt: "Synthetic search",
      userSettings: await getSettingValues(id, [...SEARCH_SETTINGS_KEYS]),
      fetchImpl: async () => {
        calls++;
        return response();
      },
    });
    expect(runtimeResult.status).toBe("offline");
    expect(calls).toBe(0);
    await db.update(channels).set({ enabled: false }).where(eq(channels.id, channelId));
    expect((await getSearchSettingsStatus(id)).configured).toBe(false);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
  }));

test("activation writes engine, active connection and verification in one transaction", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    const trigger = `search_verify_${id.replaceAll("-", "")}`;
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON settings WHEN NEW.user_id = '${id}' AND NEW.key = 'liveSearch.verification.deepseek' BEGIN SELECT RAISE(ABORT, 'forced_verification_failure'); END`,
    );
    try {
      await expect(activate(id)).rejects.toThrow();
      expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
      const active = await getSettingValues(id, [
        DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
        "liveSearch.verification.deepseek",
      ]);
      expect(Object.keys(active)).toHaveLength(0);
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }
  }));

test("Tavily verification enables its legacy switch and DuckDuckGo activation makes no request", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.tavilyApiKey", "synthetic-tavily");
    await setSettingValue(id, "liveSearch.tavilyEnabled", "false");
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
    expect((await activate(id, "tavily")).success).toBe(true);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("tavily");
    expect((await getSearchSettingsStatus(id)).verification).toBe("verified");
    expect(
      (
        await activate(id, "duckduckgo", async () => {
          throw new Error("must not request");
        })
      ).success,
    ).toBe(true);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("concurrent clicks share a per-user verification guard", () =>
  fixture(async (id) => {
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = activate(id, "deepseek", async () => {
      entered();
      await gate;
      return response();
    });
    await started;
    try {
      expect(await activate(id)).toEqual({
        success: false,
        errorCode: "search_verification_in_progress",
      });
    } finally {
      release();
    }
    expect((await first).success).toBe(true);
  }));

test("saving the first Tavily key does not implicitly activate it through auto mode", () =>
  fixture(async (id) => {
    const before = await getSearchSettingsStatus(id);
    await setSettingValue(id, "liveSearch.tavilyApiKey", "first-tavily-key");
    const after = await getSearchSettingsStatus(id);
    expect(after.effectiveProvider).toBe(before.effectiveProvider);
    const oldRuntime = (await getSettingValues(id, [TAVILY_SEARCH_RUNTIME_KEY]))[
      TAVILY_SEARCH_RUNTIME_KEY
    ];
    expect(oldRuntime === "first-tavily-key").toBe(false);
    expect((await activate(id, "tavily")).success).toBe(true);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("tavily");
    expect(
      (await getSettingValues(id, [TAVILY_SEARCH_RUNTIME_KEY]))[TAVILY_SEARCH_RUNTIME_KEY],
    ).toBe("first-tavily-key");
    await setSettingValue(id, "liveSearch.tavilyApiKey", "new-pending-key");
    expect(
      (await getSettingValues(id, [TAVILY_SEARCH_RUNTIME_KEY]))[TAVILY_SEARCH_RUNTIME_KEY],
    ).toBe("first-tavily-key");
    expect(
      (await activate(id, "tavily", async () => new Response("", { status: 401 }))).success,
    ).toBe(false);
    expect(
      (await getSettingValues(id, [TAVILY_SEARCH_RUNTIME_KEY]))[TAVILY_SEARCH_RUNTIME_KEY],
    ).toBe("first-tavily-key");
  }));

test("Tavily verification rejects private URLs and malformed model output", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.tavilyApiKey", "candidate-tavily-key");
    expect(
      await activate(
        id,
        "tavily",
        async () =>
          new Response(JSON.stringify({ results: [{ url: "http://127.0.0.1/internal" }] })),
      ),
    ).toEqual({ success: false, errorCode: "search_no_results" });
    expect(
      await activate(id, "tavily", async () => new Response(JSON.stringify({ results: [null] }))),
    ).toEqual({ success: false, errorCode: "search_invalid_response" });
  }));

test("server Chat uses the same verified Tavily credential as desktop Sidecar while a replacement is pending", () =>
  fixture(async (id) => {
    await setSettingValue(id, "liveSearch.tavilyApiKey", "working-key");
    await activate(id, "tavily");
    await setSettingValue(id, "liveSearch.tavilyApiKey", "pending-key");
    const userSettings = await getSettingValues(id, [...SEARCH_SETTINGS_KEYS]);
    const result = await buildSearchContext({
      userId: id,
      route: "web_search",
      prompt: "Synthetic official docs",
      userSettings,
      fetchImpl: async (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer working-key");
        return response();
      },
    });
    expect(result.provider).toBe("tavily");
    expect((await getSearchSettingsStatus(id)).pendingProviders).toEqual(["tavily"]);
  }));

test("saving a candidate cannot revive an unavailable legacy DeepSeek source", () =>
  fixture(async (id) => {
    await db.insert(settings).values({
      id: crypto.randomUUID(),
      userId: id,
      key: "liveSearch.provider",
      value: "deepseek",
      updatedAt: new Date(),
    });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("new-candidate"));
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
    expect(readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    expect((await activate(id)).success).toBe(true);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("deepseek");
  }));

test("configuration and revision are returned together and a later candidate cannot be activated from the old form", () =>
  fixture(async (id) => {
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("visible-X"));
    const shown = await getSearchSettingsConfiguration(id);
    expect(JSON.parse(shown.settings[DEEPSEEK_SEARCH_CONNECTION]).apiKey).toBe("visible-X");
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("unseen-Y"));
    let calls = 0;
    expect(
      await verifyAndActivateSearch(
        id,
        { provider: "deepseek", revision: shown.status.revision },
        {
          fetchImpl: async () => {
            calls++;
            return response();
          },
          resolveHostname: publicDns,
        },
      ),
    ).toEqual({ success: false, errorCode: "search_configuration_changed" });
    expect(calls).toBe(0);
    const current = await getSearchSettingsConfiguration(id);
    expect(JSON.parse(current.settings[DEEPSEEK_SEARCH_CONNECTION]).apiKey).toBe("unseen-Y");
    expect(current.status.revision === shown.status.revision).toBe(false);
  }));

test("generic provider and legacy switch writes cannot bypass Tavily verification", () =>
  fixture(async (id) => {
    await legacyTavily(id);
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await expect(setSettingValue(id, "liveSearch.provider", "tavily")).rejects.toThrow(
      "search_verification_required",
    );
    await expect(setSettingValue(id, "liveSearch.provider", "auto")).rejects.toThrow(
      "search_verification_required",
    );
    await expect(deleteSettingValue(id, "liveSearch.provider")).rejects.toThrow(
      "search_verification_required",
    );
    await setSettingValue(id, "liveSearch.tavilyEnabled", "false");
    await setSettingValue(id, "liveSearch.provider", "auto");
    await expect(setSettingValue(id, "liveSearch.tavilyEnabled", "true")).rejects.toThrow(
      "search_verification_required",
    );
    await expect(deleteSettingValue(id, "liveSearch.tavilyEnabled")).rejects.toThrow(
      "search_verification_required",
    );
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
    expect((await activate(id, "tavily")).success).toBe(true);
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await setSettingValue(id, "liveSearch.provider", "auto");
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("tavily");
  }));

test("concurrent legacy provider and enable writes cannot combine into an unverified Tavily activation", () =>
  fixture(async (id) => {
    await legacyTavily(id);
    await setSettingValue(id, "liveSearch.provider", "duckduckgo");
    await setSettingValue(id, "liveSearch.tavilyEnabled", "false");
    const results = await Promise.allSettled([
      setSettingValue(id, "liveSearch.provider", "auto"),
      setSettingValue(id, "liveSearch.tavilyEnabled", "true"),
    ]);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("an inactive saved DeepSeek candidate is never exposed to default-mode link reading", () =>
  fixture(async (id) => {
    await setSettingValue(id, DEEPSEEK_SEARCH_CONNECTION, config("inactive-candidate"));
    const userSettings = await getSettingValues(id, [...SEARCH_SETTINGS_KEYS]);
    expect(readDeepSeekSearchRuntime(userSettings)).toBe(undefined);
    let calls = 0;
    const result = await buildLinkContext({
      urls: ["https://example.com/docs"],
      webSearchEnabled: true,
      userSettings,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ content: "Synthetic page" }));
      },
    });
    expect(result.status).toBe("offline");
    expect(calls).toBe(0);
  }));

test("legacy tool credential writes cannot revive an unavailable search source or replace its working credential", () =>
  fixture(async (id) => {
    await db.insert(settings).values({
      id: crypto.randomUUID(),
      userId: id,
      key: "liveSearch.provider",
      value: "deepseek",
      updatedAt: new Date(),
    });
    await setSettingValue(id, LEGACY_TOOL_KEY, "legacy-pending-key");
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
    expect(readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))).toBe(
      undefined,
    );
    expect((await activate(id)).success).toBe(true);
    await setSettingValue(id, LEGACY_TOOL_KEY, "legacy-replacement-key");
    expect(
      readDeepSeekSearchRuntime(await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("legacy-pending-key");
  }));

test("deleting a legacy dedicated candidate cannot revive or switch to a different fallback route", async () => {
  for (const valid of [false, true])
    await fixture(async (id) => {
      const previous = valid
        ? config("working-dedicated")
        : JSON.stringify({ kind: "deepseek", source: "channel", channelId: "missing-channel" });
      await db.insert(settings).values([
        {
          id: crypto.randomUUID(),
          userId: id,
          key: "liveSearch.provider",
          value: "deepseek",
          updatedAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          userId: id,
          key: DEEPSEEK_SEARCH_CONNECTION,
          value: encrypt(previous),
          updatedAt: new Date(),
        },
        {
          id: crypto.randomUUID(),
          userId: id,
          key: LEGACY_TOOL_KEY,
          value: encrypt("different-legacy-route"),
          updatedAt: new Date(),
        },
      ]);
      await deleteSettingValue(id, DEEPSEEK_SEARCH_CONNECTION);
      const runtime = readDeepSeekSearchRuntime(
        await getSettingValues(id, [DEEPSEEK_SEARCH_RUNTIME]),
      );
      expect(runtime?.apiKey).toBe(valid ? "working-dedicated" : undefined);
      expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe(
        valid ? "deepseek" : "none",
      );
    });
});
