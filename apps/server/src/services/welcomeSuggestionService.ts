import { conversations } from "db";
import { desc, eq } from "drizzle-orm";
import { createAdapter } from "../agent-adapters";
import { db } from "../db";
import { getChannels, getResolvedChannelForUser } from "./channelService";
import { getSettingValues, setSettingValue } from "./settingsService";

/**
 * Suggestions shown on the desktop welcome screen.
 *
 * Generating these costs a model round-trip, which must never sit in front of
 * the first paint. So the read path only ever returns what is already cached and
 * schedules a refresh in the background; the UI shows its built-in defaults
 * until a generated set exists, then swaps them in on a later visit.
 */

const SETTING_KEY = "welcome.suggestions";
const TTL_MS = 12 * 60 * 60 * 1000;
export const SUGGESTION_COUNT = 3;
/** Long enough to be a real task, short enough for one line in the UI. */
const MAX_SUGGESTION_LENGTH = 24;
/** How many recent titles describe "what this user works on". */
const CONTEXT_TITLE_COUNT = 15;

interface CachedSuggestions {
  items: string[];
  generatedAt: number;
  /** Fingerprint of the context used, so new activity invalidates the cache. */
  seed: string;
}

function parseCache(raw: string | undefined): CachedSuggestions | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedSuggestions>;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    const items = parsed.items.filter((item): item is string => typeof item === "string");
    if (items.length === 0) return null;
    return {
      items,
      generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : 0,
      seed: typeof parsed.seed === "string" ? parsed.seed : "",
    };
  } catch {
    return null;
  }
}

async function readContext(userId: string) {
  const rows = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(CONTEXT_TITLE_COUNT);

  const titles = rows.map((row) => row.title.trim()).filter((title) => title.length > 0);
  // The newest conversation id plus the count is enough to notice "the user has
  // done something since" without hashing every title.
  const seed = `${rows[0]?.id ?? "none"}:${rows.length}`;
  return { titles, seed };
}

function isFresh(cache: CachedSuggestions, seed: string, now: number): boolean {
  return cache.seed === seed && now - cache.generatedAt < TTL_MS;
}

/** Strips list numbering, bullets and quotes the model may wrap each line in. */
function normalizeSuggestion(line: string): string {
  const cleaned = line
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.、)]\s*/, "")
    .replace(/^["'“”‘’]|["'“”‘’]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_SUGGESTION_LENGTH ? "" : cleaned;
}

function parseModelOutput(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const item = normalizeSuggestion(line);
    if (item && !out.includes(item)) out.push(item);
    if (out.length === SUGGESTION_COUNT) break;
  }
  return out;
}

function buildPrompt(titles: string[]): string {
  return [
    "下面是一位用户最近的对话标题，反映了他平时在做的事：",
    "",
    titles.map((title) => `- ${title}`).join("\n"),
    "",
    `请据此写 ${SUGGESTION_COUNT} 条他接下来可能想做的任务，作为新会话的输入建议。要求：`,
    "- 每条独立成行，不要编号、不要符号前缀、不要引号",
    `- 每条不超过 ${MAX_SUGGESTION_LENGTH} 个字，是一句可以直接发给助手的话`,
    "- 三条之间方向不同，不要互相重复",
    "- 只输出这三行，不要任何其他内容",
  ].join("\n");
}

async function tryChannel(userId: string, channelId: string, titles: string[]): Promise<string[]> {
  const resolved = await getResolvedChannelForUser(userId, channelId);
  if (!resolved) return [];

  const adapter = createAdapter(
    resolved.channel.protocol,
    resolved.apiKey,
    resolved.channel.baseUrl || undefined,
  );

  const response = await adapter.chat({
    model: resolved.modelId,
    messages: [{ role: "user", content: buildPrompt(titles) }],
    maxTokens: 200,
  });

  return parseModelOutput(response.content ?? "");
}

async function generate(userId: string, titles: string[]): Promise<string[]> {
  const channels = await getChannels(userId);
  const enabled = channels.filter((channel) => channel.enabled);
  if (enabled.length === 0) return [];

  // Default channel first, then the rest — the default is out of quota often
  // enough (429) that giving up on it would mean never producing suggestions,
  // even with other working channels configured. Mirrors autoTitleService.
  const ordered = [
    ...enabled.filter((channel) => channel.isDefault),
    ...enabled.filter((channel) => !channel.isDefault),
  ];

  for (const channel of ordered) {
    try {
      const items = await tryChannel(userId, channel.id, titles);
      if (items.length > 0) return items;
    } catch {
      // Quota, network, or a model that ignored the format — try the next one.
    }
  }
  return [];
}

// One in-flight refresh per user. A burst of welcome-screen visits would
// otherwise each fire their own generation against the same context.
const inFlight = new Set<string>();

export async function refreshWelcomeSuggestions(userId: string): Promise<string[]> {
  if (inFlight.has(userId)) return [];
  inFlight.add(userId);
  try {
    const { titles, seed } = await readContext(userId);
    // Nothing to personalise from — leave the cache empty so the UI keeps its
    // built-in defaults rather than storing something generic.
    if (titles.length === 0) return [];

    const items = await generate(userId, titles);
    if (items.length === 0) return [];

    const payload: CachedSuggestions = { items, generatedAt: Date.now(), seed };
    await setSettingValue(userId, SETTING_KEY, JSON.stringify(payload));
    return items;
  } catch {
    // Best-effort: a failed generation just means the UI keeps its defaults.
    return [];
  } finally {
    inFlight.delete(userId);
  }
}

/**
 * Read path for the welcome screen. Returns only what is already cached and
 * never awaits a generation — a stale or missing cache schedules a refresh whose
 * result the *next* visit picks up.
 */
export async function getWelcomeSuggestions(
  userId: string,
): Promise<{ suggestions: string[]; stale: boolean }> {
  const values = await getSettingValues(userId, [SETTING_KEY]);
  const cache = parseCache(values[SETTING_KEY]);
  const { seed } = await readContext(userId);
  const fresh = cache ? isFresh(cache, seed, Date.now()) : false;

  if (!fresh) {
    void refreshWelcomeSuggestions(userId);
  }

  return { suggestions: cache?.items ?? [], stale: !fresh };
}
