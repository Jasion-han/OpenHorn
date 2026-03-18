import { createAdapter } from "../agent-adapters";
import { getResolvedChannelForUser } from "./channelService";

export async function generateAutoTitle(
  userId: string,
  userPrompt: string,
  channelId?: string | null,
): Promise<string | null> {
  try {
    const resolved = await getResolvedChannelForUser(userId, channelId || null);
    if (!resolved) return null;

    const adapter = createAdapter(
      resolved.channel.provider,
      resolved.apiKey,
      resolved.channel.baseUrl || undefined,
    );

    const response = await adapter.chat({
      model: resolved.modelId,
      messages: [
        {
          role: "user",
          content: `请用5到10个字为下面这条用户消息生成一个简短的标题，只输出标题本身，不要加引号或其他内容：\n\n${userPrompt.slice(0, 500)}`,
        },
      ],
      maxTokens: 30,
    });

    const title = response.content
      .trim()
      .replace(/^["'\u201c\u201d\u2018\u2019]|["'\u201c\u201d\u2018\u2019]$/g, "")
      .trim();
    if (!title) return null;
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${title.slice(0, 40)} ${mm}-${dd} ${hh}:${min}`;
  } catch {
    return null;
  }
}
