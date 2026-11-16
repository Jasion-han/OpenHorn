import { expect, test } from "bun:test";
import { DEEPSEEK_SEARCH_CONNECTION } from "shared/deepseek-search";
import { LEGACY_TOOL_KEY, TOOL_CONNECTION_SETTING } from "shared/tool-connection";
import {
  emptyToolConnection,
  isToolDraftReady,
  loadToolDraft,
  sameToolDraft,
  serializeToolDraft,
} from "./toolConnectionDraft";

test("new search settings ask for a Key without offering unverified model channels", () => {
  expect(loadToolDraft({}).source).toBe("manual");
  expect(isToolDraftReady(emptyToolConnection)).toBe(false);
  const stored = JSON.parse(
    serializeToolDraft({
      ...emptyToolConnection,
      source: "channel",
      channelId: "owned",
      key: "stale-key",
    }),
  );
  expect(stored).toEqual({ kind: "deepseek", source: "channel", channelId: "owned" });
  expect(Object.hasOwn(stored, "model")).toBe(false);
  expect(Object.hasOwn(stored, "apiKey")).toBe(false);
});

test("official legacy Key and compatible relay connection remain usable", () => {
  const legacy = loadToolDraft({ [LEGACY_TOOL_KEY]: "old-official" });
  expect(legacy.source).toBe("manual");
  expect(legacy.baseUrl).toBe("https://api.deepseek.com/v1");
  const relay = {
    ...emptyToolConnection,
    source: "manual" as const,
    baseUrl: "https://relay.example.com/v1",
    key: "relay-only",
  };
  const stored = serializeToolDraft(relay);
  expect(sameToolDraft(loadToolDraft({ [DEEPSEEK_SEARCH_CONNECTION]: stored }), relay)).toBe(true);
  expect(JSON.parse(stored).kind).toBe("deepseek");
});

test("a previous OpenRouter tool connection cannot be presented as DeepSeek Search", () => {
  const router = JSON.stringify({
    kind: "openrouter",
    source: "manual",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "router-only",
    model: "test/model",
  });
  expect(
    loadToolDraft({ [TOOL_CONNECTION_SETTING]: router, [LEGACY_TOOL_KEY]: "official-key" }),
  ).toEqual(emptyToolConnection);
  let rejected = false;
  try {
    loadToolDraft({ [DEEPSEEK_SEARCH_CONNECTION]: router });
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});
