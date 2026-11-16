import { normalizeToolBaseUrl, type ToolConnection } from "../tool-connection";
import { readBoundedWebResponse, type WebToolsFetchFn } from "./deepseekProvider";
import { assertPublicWebUrl, type ResolveWebHostname } from "./webSafety";

export type ToolRequestOptions = {
  connection: ToolConnection;
  fetchImpl?: WebToolsFetchFn;
  resolveHostname?: ResolveWebHostname;
  signal?: AbortSignal;
  timeoutMs?: number;
  targetUrl?: string;
  /** Only the fixed official native Responses endpoint may use this trust boundary. */
  trustedNativeEndpoint?: boolean;
  /** Only the fixed official OpenRouter chat endpoint may bypass fake-IP DNS. */
  trustedOpenRouterEndpoint?: boolean;
};

/** One bounded, credential-bound request. Never follows redirects or retries billing. */
export async function requestToolJson(
  path: string,
  body: unknown,
  options: ToolRequestOptions,
): Promise<unknown> {
  const { connection } = options;
  if (!connection.apiKey.trim()) throw new Error("not_configured");
  const endpoint = `${normalizeToolBaseUrl(connection.baseUrl)}${path}`;
  const timeout = AbortSignal.timeout(Math.min(60_000, Math.max(1, options.timeoutMs ?? 15_000)));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(options.signal?.aborted ? "aborted" : "timeout"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = async () => {
      if (options.targetUrl) await assertPublicWebUrl(options.targetUrl, options.resolveHostname);
      // Like the official standalone DeepSeek tools, this fixed HTTPS origin is trusted.
      // TLS authenticates it even under local fake-IP proxies; arbitrary relays keep DNS checks.
      if (
        !(options.trustedNativeEndpoint && endpoint === "https://api.deepseek.com/v1/responses") &&
        !(
          options.trustedOpenRouterEndpoint &&
          endpoint === "https://openrouter.ai/api/v1/chat/completions"
        )
      )
        await assertPublicWebUrl(endpoint, options.resolveHostname);
      signal.throwIfAborted();
      const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await readBoundedWebResponse(response, undefined, signal);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("invalid_response");
      }
    };
    return await Promise.race([work(), aborted]);
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? "aborted" : "timeout");
    const message = error instanceof Error ? error.message : "";
    throw new Error(
      /^(unsafe_url|invalid_tool_endpoint|invalid_response|response_too_large|HTTP \d{3})$/.test(
        message,
      )
        ? message
        : "request_failed",
    );
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
