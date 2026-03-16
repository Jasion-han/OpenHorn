import { createAdapter } from '../agent-adapters';
import type { LiveRouteType } from './liveCapabilities';

export async function classifyLiveRouteWithModel(params: {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  modelId: string;
  prompt: string;
}): Promise<LiveRouteType | null> {
  const trimmed = params.prompt.trim();
  if (!trimmed) return null;

  try {
    const adapter = createAdapter(params.provider, params.apiKey, params.baseUrl || undefined);
    const response = await adapter.chat({
      model: params.modelId,
      temperature: 0,
      maxTokens: 16,
      messages: [
        {
          role: 'system',
          content: 'Classify the user query into one of: local, structured_live, web_search, research, direct_model. Respond with a single label only.',
        },
        {
          role: 'user',
          content: trimmed,
        },
      ],
    });

    const text = response.content.toLowerCase();
    const labels: LiveRouteType[] = ['local', 'structured_live', 'web_search', 'research', 'direct_model'];
    return labels.find((label) => text.includes(label)) || null;
  } catch {
    return null;
  }
}
