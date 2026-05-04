import { createAdapter } from "../agent-adapters";
import { getChannels, getResolvedChannelForUser } from "./channelService";

function formatTimestamp() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function fallbackTitle(userPrompt: string): string {
  let cleaned = userPrompt.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/[?？!！。，,.\s]+$/g, "");
  const truncated = cleaned.length > 20 ? `${cleaned.slice(0, 20)}…` : cleaned;
  return `${truncated} ${formatTimestamp()}`;
}

const TITLE_PROMPT_PREFIX =
  "请用5到10个字为下面这条用户消息生成一个简短的中文陈述句标题（不要疑问句），只输出标题本身，不要加引号或其他内容：\n\n";

async function tryGenerateWithChannel(
  userId: string,
  channelId: string,
  userPrompt: string,
): Promise<string | null> {
  const resolved = await getResolvedChannelForUser(userId, channelId);
  if (!resolved) return null;

  const adapter = createAdapter(
    resolved.channel.protocol,
    resolved.apiKey,
    resolved.channel.baseUrl || undefined,
  );

  const response = await adapter.chat({
    model: resolved.modelId,
    messages: [
      { role: "user", content: `${TITLE_PROMPT_PREFIX}${userPrompt.slice(0, 500)}` },
    ],
    maxTokens: 30,
  });

  const title = response.content
    .trim()
    .replace(/^["'""'']|["'""'']$/g, "")
    .trim();
  return title || null;
}

export async function generateAutoTitle(
  userId: string,
  userPrompt: string,
  channelId?: string | null,
): Promise<string | null> {
  const channels = await getChannels(userId);
  const enabledIds = channels.filter((c) => c.enabled).map((c) => c.id);
  if (enabledIds.length === 0) return fallbackTitle(userPrompt);

  const primaryId = channelId && enabledIds.includes(channelId) ? channelId : null;
  const candidateIds = primaryId
    ? [primaryId, ...enabledIds.filter((id) => id !== primaryId)]
    : enabledIds;

  for (const id of candidateIds) {
    try {
      const title = await tryGenerateWithChannel(userId, id, userPrompt);
      if (title) {
        return `${title.slice(0, 40)} ${formatTimestamp()}`;
      }
    } catch {
      continue;
    }
  }

  return fallbackTitle(userPrompt);
}
