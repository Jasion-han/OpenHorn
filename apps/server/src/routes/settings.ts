import { type Context, Hono } from "hono";
import { readToolRuntime, TOOL_RUNTIME_SETTING } from "shared/tool-connection";
import { saveNativeSearchConfig } from "../services/nativeSearchSettings";
import { saveOpenRouterSearchConfig } from "../services/openRouterSearchSettings";
import {
  getSearchSettingsConfiguration,
  getSearchSettingsStatus,
  verifyAndActivateSearch,
} from "../services/searchSettingsService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "../services/settingsService";
import { toolConnectionFingerprint } from "../services/toolConnectionService";
import { getWelcomeSuggestions } from "../services/welcomeSuggestionService";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { isRecord } from "../utils/typeGuards";

const settings = new Hono<UserEnv>();

settings.use("*", requireUser);

function parseKeysQuery(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

settings.get("/", async (c) => {
  const user = c.get("user");

  const keys = parseKeysQuery(c.req.query("keys"));
  const values = await getSettingValues(user.id, keys);
  c.header("Cache-Control", "no-store");
  return c.json({ settings: values });
});

// Read-only and deliberately non-blocking: returns whatever is cached and lets
// the service schedule a refresh in the background, so the welcome screen never
// waits on a model round-trip.
settings.get("/welcome-suggestions", async (c) => {
  const user = c.get("user");

  const result = await getWelcomeSuggestions(user.id);
  return c.json(result);
});

settings.get("/tool-status", async (c) => {
  const values = await getSettingValues(c.get("user").id, [TOOL_RUNTIME_SETTING]);
  const connection = readToolRuntime(values);
  c.header("Cache-Control", "no-store");
  return c.json(
    connection
      ? {
          configured: true,
          kind: connection.kind,
          endpoint: connection.baseUrl,
          connectionToken: toolConnectionFingerprint(connection),
        }
      : { configured: false },
  );
});

settings.get("/search-status", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await getSearchSettingsStatus(c.get("user").id));
});

settings.get("/search-configuration", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await getSearchSettingsConfiguration(c.get("user").id));
});

// A two-segment route fails closed on older servers instead of storing an unknown secret key.
settings.put("/search/native-connection", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || (body.value !== null && typeof body.value !== "string"))
    return c.json({ error: "invalid_native_search_config" }, 400);
  try {
    await saveNativeSearchConfig(
      c.get("user").id,
      typeof body.value === "string" ? body.value : null,
    );
    return c.json({ success: true });
  } catch {
    return c.json({ error: "native_search_connection_unavailable" }, 400);
  }
});

settings.put("/search/openrouter-connection", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || (body.value !== null && typeof body.value !== "string"))
    return c.json({ error: "invalid_openrouter_search_config" }, 400);
  try {
    await saveOpenRouterSearchConfig(
      c.get("user").id,
      typeof body.value === "string" ? body.value : null,
    );
    return c.json({ success: true });
  } catch {
    return c.json({ error: "invalid_openrouter_search_config" }, 400);
  }
});

const runSearchVerification = (activate: boolean) => async (c: Context<UserEnv>) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.provider !== "string" ||
    !["tavily", "deepseek", "deepseek-native", "openrouter", "duckduckgo"].includes(
      body.provider,
    ) ||
    typeof body.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.revision)
  )
    return c.json({ error: "invalid_search_activation" }, 400);
  c.header("Cache-Control", "no-store");
  try {
    return c.json(
      await verifyAndActivateSearch(
        c.get("user").id,
        {
          provider: body.provider as
            | "tavily"
            | "deepseek"
            | "deepseek-native"
            | "openrouter"
            | "duckduckgo",
          revision: body.revision,
        },
        { activate },
      ),
    );
  } catch {
    return c.json({ success: false, errorCode: "search_request_failed" });
  }
};
settings.post("/search/verify-and-activate", runSearchVerification(true));
// A distinct route fails closed on old servers instead of accidentally switching the source.
settings.post("/search/verify", runSearchVerification(false));

settings.put("/:key", async (c) => {
  const user = c.get("user");

  const key = c.req.param("key");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }

  const value = isRecord(body) ? body.value : undefined;
  try {
    if (value === null) {
      await deleteSettingValue(user.id, key);
      return c.json({ success: true });
    }

    if (typeof value === "string") {
      await setSettingValue(user.id, key, value);
      return c.json({ success: true });
    }

    return c.json({ error: "value must be a string or null" }, 400);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to update setting" },
      400,
    );
  }
});

export default settings;
