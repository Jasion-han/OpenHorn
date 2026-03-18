import { Hono } from "hono";
import { TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING } from "../services/searchService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "../services/settingsService";
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
  return c.json({ settings: values });
});

settings.get("/search-status", async (c) => {
  const user = c.get("user");

  const values = await getSettingValues(user.id, [TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING]);
  const enabledRaw = values[TAVILY_ENABLED_SETTING];
  if (typeof enabledRaw === "string" && enabledRaw.trim().toLowerCase() === "false") {
    return c.json({ configured: false, source: "disabled" });
  }

  const userKey = values[TAVILY_API_KEY_SETTING];
  if (typeof userKey === "string" && userKey.trim()) {
    return c.json({ configured: true, source: "user" });
  }

  const envKey = process.env.TAVILY_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) {
    return c.json({ configured: true, source: "server" });
  }

  return c.json({ configured: false, source: "none" });
});

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
