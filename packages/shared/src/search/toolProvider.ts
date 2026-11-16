import { fetchDeepSeek, searchDeepSeek, type WebPageSource } from "./deepseekProvider";
import { requestToolJson, type ToolRequestOptions } from "./toolTransport";
import type { SearchCitation } from "./types";
import { parsePublicWebUrl } from "./webSafety";

type ObjectValue = Record<string, unknown>;
export const toolObject = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

export function openRouterMessage(payload: unknown): ObjectValue {
  const root = toolObject(payload);
  const choice = toolObject(Array.isArray(root?.choices) ? root.choices[0] : null);
  const message = toolObject(choice?.message);
  if (root?.error || choice?.finish_reason !== "stop" || !message || message.refusal)
    throw new Error("invalid_response");
  return message;
}

function citations(message: ObjectValue): SearchCitation[] {
  const result: SearchCitation[] = [];
  for (const raw of Array.isArray(message.annotations) ? message.annotations : []) {
    const annotation = toolObject(raw);
    if (annotation?.type !== "url_citation") continue;
    const source = toolObject(annotation.url_citation);
    if (typeof source?.url !== "string") continue;
    try {
      parsePublicWebUrl(source.url);
    } catch {
      continue;
    }
    const content =
      typeof source.content === "string" ? source.content.slice(0, 50_000) : undefined;
    result.push({
      url: source.url,
      title: typeof source.title === "string" ? source.title.slice(0, 500) : source.url,
      ...(content ? { content } : {}),
    });
  }
  return result;
}

async function routerWeb(
  prompt: string,
  type: "openrouter:web_search" | "openrouter:web_fetch",
  options: ToolRequestOptions,
): Promise<SearchCitation[]> {
  if (!options.connection.model) throw new Error("tool_model_required");
  const payload = await requestToolJson(
    "/chat/completions",
    {
      model: options.connection.model,
      stream: false,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type,
          parameters:
            type === "openrouter:web_search"
              ? { max_results: 5, max_uses: 1 }
              : {
                  max_content_tokens: 16000,
                  allowed_domains: options.targetUrl ? [new URL(options.targetUrl).hostname] : [],
                },
        },
      ],
      tool_choice: { type },
    },
    options,
  );
  const sources = citations(openRouterMessage(payload));
  if (!sources.length) throw new Error("no_sources");
  return sources;
}

export async function searchToolService(
  query: string,
  options: ToolRequestOptions & { maxResults?: number },
): Promise<SearchCitation[]> {
  if (options.connection.kind === "deepseek")
    return searchDeepSeek(query, {
      ...options,
      apiKey: options.connection.apiKey,
      baseUrl: options.connection.baseUrl,
    });
  if (!query.trim() || Array.from(query).length > 128) throw new Error("invalid_query");
  return (
    await routerWeb(
      `Search the web for this query and cite the retrieved sources: ${JSON.stringify(query)}`,
      "openrouter:web_search",
      options,
    )
  ).slice(0, options.maxResults ?? 5);
}

export async function fetchToolService(
  url: string,
  options: ToolRequestOptions,
): Promise<WebPageSource> {
  if (options.connection.kind === "deepseek")
    return fetchDeepSeek(url, {
      ...options,
      apiKey: options.connection.apiKey,
      baseUrl: options.connection.baseUrl,
    });
  options.signal?.throwIfAborted();
  const target = parsePublicWebUrl(url);
  target.hash = "";
  const sources = await routerWeb(
    `Fetch this exact URL and cite it with the extracted source content: ${JSON.stringify(url)}`,
    "openrouter:web_fetch",
    { ...options, targetUrl: url },
  );
  const source = sources.find((item) => {
    const candidate = new URL(item.url);
    candidate.hash = "";
    return candidate.href === target.href && item.content?.trim();
  });
  // Model-generated prose is not a copy of the fetched page.
  if (!source?.content) throw new Error("source_content_unavailable");
  return { ...source, content: source.content, truncated: source.content.length >= 50_000 };
}
