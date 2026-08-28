import { conversations, messages } from "db";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { createAdapter } from "../agent-adapters";
import { db } from "../db";
import { getChannels, getResolvedChannelForUser } from "./channelService";

/** Minimum number of messages before a conversation is eligible for summarization. */
const SUMMARY_MESSAGE_THRESHOLD = 10;

/** Cooldown between consecutive summarization attempts for the same conversation. */
const SUMMARY_COOLDOWN_MS = 5 * 60 * 1000;

const SUMMARY_PROMPT =
  "请为以下对话生成一段简洁的中文摘要（100-200字），提取关键事实和结论。只输出摘要内容，不要加标题或前缀。\n\n对话内容：\n";

const KEY_FACTS_PROMPT =
  "请从以下对话中提取关键事实、决策和用户偏好，以JSON数组格式输出。每个元素是一个字符串，描述一个独立的事实。最多10条，每条不超过50字。只输出JSON数组。\n\n对话内容：\n";

/**
 * Conditionally generates a summary for a conversation when it has enough
 * messages and the cooldown period has elapsed. Fire-and-forget -- callers
 * should never await this or let its errors propagate.
 */
export async function maybeSummarize(userId: string, conversationId: string): Promise<void> {
  const conv = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  if (!conv[0]) return;

  const msgRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  if (msgRows.length < SUMMARY_MESSAGE_THRESHOLD) return;

  if (conv[0].lastSummarizedAt) {
    const since = Date.now() - conv[0].lastSummarizedAt.getTime();
    if (since < SUMMARY_COOLDOWN_MS) return;
  }

  await generateSummary(userId, conversationId);
}

async function generateSummary(userId: string, conversationId: string): Promise<void> {
  // Fetch recent messages for the transcript
  const allMessages = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(30);

  // Reverse so they are chronological
  allMessages.reverse();

  const transcript = allMessages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${(m.content || "").slice(0, 500)}`)
    .join("\n\n");

  // Find an enabled channel to use for the LLM call (same pattern as autoTitleService)
  const channelItems = await getChannels(userId);
  const enabledIds = channelItems.filter((c) => c.enabled).map((c) => c.id);
  if (enabledIds.length === 0) return;

  let resolved: Awaited<ReturnType<typeof getResolvedChannelForUser>> = null;
  for (const id of enabledIds) {
    try {
      resolved = await getResolvedChannelForUser(userId, id);
      if (resolved) break;
    } catch {
      // try next
    }
  }
  if (!resolved) return;

  const adapter = createAdapter(
    resolved.channel.protocol,
    resolved.apiKey,
    resolved.channel.baseUrl || undefined,
  );

  const model = resolved.modelId;

  try {
    const [summaryResp, factsResp] = await Promise.all([
      adapter.chat({
        model,
        messages: [{ role: "user", content: SUMMARY_PROMPT + transcript }],
        maxTokens: 300,
      }),
      adapter.chat({
        model,
        messages: [{ role: "user", content: KEY_FACTS_PROMPT + transcript }],
        maxTokens: 500,
      }),
    ]);

    await db
      .update(conversations)
      .set({
        summary: summaryResp.content.trim(),
        keyFacts: factsResp.content.trim(),
        lastSummarizedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  } catch {
    // Silent failure -- same pattern as autoTitleService
  }
}

/**
 * Retrieves recent conversation summaries for a user, excluding a specific
 * conversation. Used to inject "memory" into new conversations.
 */
export async function getRecentSummaries(
  userId: string,
  excludeConversationId: string,
  limit = 5,
): Promise<Array<{ title: string | null; summary: string }>> {
  const results = await db
    .select({
      title: conversations.title,
      summary: conversations.summary,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        isNotNull(conversations.summary),
        ne(conversations.id, excludeConversationId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);

  return results
    .filter((r) => r.summary)
    .map((r) => ({
      title: r.title,
      summary: r.summary as string,
    }));
}
