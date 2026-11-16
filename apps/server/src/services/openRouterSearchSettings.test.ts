import { expect, test } from "bun:test";
import { settings, users } from "db";
import { and, eq } from "drizzle-orm";
import {
  OPENROUTER_SEARCH_ACTIVE,
  OPENROUTER_SEARCH_CONFIG,
  OPENROUTER_SEARCH_MODEL,
  OPENROUTER_SEARCH_RUNTIME,
  readOpenRouterSearchRuntime,
} from "shared/openrouter-search";
import { TOOL_CONNECTION_SETTING } from "shared/tool-connection";
import { client, db } from "../db";
import { isSafeBackupSetting } from "./backupSanitizer";
import {
  getSearchSettingsConfiguration,
  getSearchSettingsStatus,
  verifyAndActivateSearch,
} from "./searchSettingsService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "./settingsService";

const config = (apiKey = "fixture-search-only-key") => JSON.stringify({ apiKey });
const response = () => ({
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Retrieved documentation summary",
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              url: "https://example.com/docs",
              title: "Fixture docs",
              content: "Source excerpt",
            },
          },
        ],
      },
    },
  ],
});
async function fixture(run: (id: string) => Promise<void>) {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "router-search",
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
    await db.delete(users).where(eq(users.id, id));
  }
}
const activate = async (id: string, fetchImpl = async () => Response.json(response())) =>
  verifyAndActivateSearch(
    id,
    { provider: "openrouter", revision: (await getSearchSettingsStatus(id)).revision },
    { fetchImpl, resolveHostname: async () => ["93.184.216.34"] },
  );

test("OpenRouter candidate is encrypted, isolated and never activates before evidence verification", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
    expect(
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME])),
    ).toBe(undefined);
    await expect(setSettingValue(id, "liveSearch.provider", "openrouter")).rejects.toThrow(
      "search_verification_required",
    );
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, OPENROUTER_SEARCH_CONFIG)));
    expect(row.value.startsWith("v2:")).toBe(true);
    expect(row.value.includes("fixture-search-only-key")).toBe(false);
    const snapshot = await getSearchSettingsConfiguration(id);
    expect(snapshot.openRouterSearchAvailable).toBe(true);
    expect(snapshot.status.availableProviders?.includes("openrouter")).toBe(false);
    expect(JSON.parse(snapshot.settings[OPENROUTER_SEARCH_CONFIG]).model).toBe(
      OPENROUTER_SEARCH_MODEL,
    );
    expect((await activate(id)).success).toBe(true);
    const status = await getSearchSettingsStatus(id);
    expect(status.effectiveProvider).toBe("openrouter");
    expect(status.verification).toBe("verified");
    expect(status.availableProviders?.includes("openrouter")).toBe(true);
    expect(status.openRouterConnection).toMatchObject({
      engine: "exa",
      model: OPENROUTER_SEARCH_MODEL,
    });
    expect(JSON.stringify(status).includes("fixture-search-only-key")).toBe(false);
    expect(
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("fixture-search-only-key");
  }));

test("OpenRouter model prose without structured citations cannot replace a working source", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
    const result = await activate(id, async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "I searched https://example.com/docs" },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("OpenRouter candidate replacements and deletion preserve active credentials until verified", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config("working-search-key"));
    await activate(id);
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config("unverified-new-key"));
    expect((await getSearchSettingsStatus(id)).pendingProviders).toEqual(["openrouter"]);
    expect(
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("working-search-key");
    await deleteSettingValue(id, OPENROUTER_SEARCH_CONFIG);
    expect(
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME]))?.apiKey,
    ).toBe("working-search-key");
    for (const key of [
      OPENROUTER_SEARCH_ACTIVE,
      OPENROUTER_SEARCH_RUNTIME,
      "liveSearch.verification.openrouter",
    ]) {
      await expect(setSettingValue(id, key, config())).rejects.toThrow("read_only_setting");
      await expect(deleteSettingValue(id, key)).rejects.toThrow("read_only_setting");
      expect(isSafeBackupSetting({ key, value: config() })).toBe(false);
    }
    expect(isSafeBackupSetting({ key: OPENROUTER_SEARCH_CONFIG, value: config() })).toBe(false);
  }));

test("OpenRouter late verification cannot activate a changed key", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
    const result = await activate(id, async () => {
      await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config("changed-during-verification"));
      return Response.json(response());
    });
    expect(result).toEqual({ success: false, errorCode: "search_configuration_changed" });
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
  }));

test("OpenRouter activation rolls back source, credentials and verification on transaction failure", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
    const trigger = `router_activation_${id.replaceAll("-", "")}`;
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON settings WHEN NEW.user_id = '${id}' AND NEW.key = 'liveSearch.verification.openrouter' BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`,
    );
    try {
      await expect(activate(id)).rejects.toThrow();
      expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("duckduckgo");
      expect(Object.keys(await getSettingValues(id, [OPENROUTER_SEARCH_ACTIVE]))).toHaveLength(0);
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }
  }));

test("OpenRouter cannot borrow a Jev or legacy tool Key, and changing source removes its runtime", () =>
  fixture(async (id) => {
    const previous = process.env.OPENHORN_JEV_API_KEY;
    const decisionKey = "fixture-decision-key";
    process.env.OPENHORN_JEV_API_KEY = decisionKey;
    try {
      await setSettingValue(
        id,
        TOOL_CONNECTION_SETTING,
        JSON.stringify({
          source: "manual",
          kind: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "fixture-legacy-tool-key",
          model: "deepseek/deepseek-v4-pro",
        }),
      );
      expect(await activate(id)).toEqual({ success: false, errorCode: "search_not_configured" });
      await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
      await activate(id);
      expect(process.env.OPENHORN_JEV_API_KEY).toBe(decisionKey);
      await setSettingValue(id, "liveSearch.provider", "duckduckgo");
      expect(
        readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME])),
      ).toBe(undefined);
    } finally {
      if (previous === undefined) delete process.env.OPENHORN_JEV_API_KEY;
      else process.env.OPENHORN_JEV_API_KEY = previous;
    }
  }));

test("an OpenRouter active connection changed behind the verification fingerprint is revoked", () =>
  fixture(async (id) => {
    await setSettingValue(id, OPENROUTER_SEARCH_CONFIG, config());
    await activate(id);
    const { encrypt } = await import("../utils");
    const { parseOpenRouterSearchConfig } = await import("shared/openrouter-search");
    await db
      .update(settings)
      .set({
        value: encrypt(JSON.stringify(parseOpenRouterSearchConfig(config("tampered-active-key")))),
      })
      .where(and(eq(settings.userId, id), eq(settings.key, OPENROUTER_SEARCH_ACTIVE)));
    expect((await getSearchSettingsStatus(id)).effectiveProvider).toBe("none");
    expect((await getSearchSettingsStatus(id)).availableProviders?.includes("openrouter")).toBe(
      false,
    );
    expect(
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME])),
    ).toBe(undefined);
  }));

test("Flash candidate cannot inherit Pro verification or replace Pro until its own evidence passes", () =>
  fixture(async (id) => {
    await setSettingValue(
      id,
      OPENROUTER_SEARCH_CONFIG,
      JSON.stringify({ apiKey: "same-search-key", model: "deepseek/deepseek-v4-pro" }),
    );
    await activate(id);
    const runtime = async () =>
      readOpenRouterSearchRuntime(await getSettingValues(id, [OPENROUTER_SEARCH_RUNTIME]));
    expect((await runtime())?.model).toBe("deepseek/deepseek-v4-pro");
    await setSettingValue(
      id,
      OPENROUTER_SEARCH_CONFIG,
      JSON.stringify({ apiKey: "same-search-key", model: OPENROUTER_SEARCH_MODEL }),
    );
    expect((await getSearchSettingsStatus(id)).pendingProviders).toEqual(["openrouter"]);
    expect((await runtime())?.model).toBe("deepseek/deepseek-v4-pro");
    expect((await activate(id, async () => Response.json({ choices: [] }))).success).toBe(false);
    expect((await runtime())?.model).toBe("deepseek/deepseek-v4-pro");
    expect((await activate(id)).success).toBe(true);
    expect((await runtime())?.model).toBe(OPENROUTER_SEARCH_MODEL);
  }));
