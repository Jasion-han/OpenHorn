import { createAdapter } from "../agent-adapters";
import type { LiveRouteType } from "./liveCapabilities";

const LIVE_ROUTE_CLASSIFIER_TIMEOUT_MS = 1_200;

export async function classifyLiveRouteWithModel(params: {
  protocol: "openai" | "anthropic" | "google";
  apiKey: string;
  baseUrl?: string | null;
  modelId: string;
  prompt: string;
}): Promise<LiveRouteType | null> {
  const trimmed = params.prompt.trim();
  if (!trimmed) return null;

  try {
    const adapter = createAdapter(params.protocol, params.apiKey, params.baseUrl || undefined);
    const response = await adapter.chat({
      model: params.modelId,
      temperature: 0,
      maxTokens: 8,
      requestTimeoutMs: LIVE_ROUTE_CLASSIFIER_TIMEOUT_MS,
      messages: [
        {
          role: "system",
          content:
            "Classify the user query into one of: local, structured_live, web_search, research, direct_model. Use web_search or research only when the answer depends on current external information, live facts, recent changes, explicit web lookup, or source-backed verification. Identity questions, greetings, translation, rewriting, summarization, coding help, and stable concept explanations should be direct_model. Respond with a single label only.",
        },
        {
          role: "user",
          content: trimmed,
        },
      ],
    });

    const text = response.content.toLowerCase();
    const labels: LiveRouteType[] = [
      "local",
      "structured_live",
      "web_search",
      "research",
      "direct_model",
    ];
    return labels.find((label) => text.includes(label)) || null;
  } catch {
    return null;
  }
}
