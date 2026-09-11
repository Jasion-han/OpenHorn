import type { CredentialSource } from "./credentialApi";
import type { ServerApi } from "./serverApi";

/**
 * Creates the placeholder channel for a CLI-login credential source
 * (`__cli_oauth__:<sourceId>` — the server resolves the real token at request
 * time). Shared by the credentials panel and the import center so the two
 * entry points can never drift apart in provider/protocol/baseUrl handling.
 */
export function createCliOAuthChannel(api: ServerApi, source: CredentialSource) {
  const protocol = source.provider === "anthropic" ? "anthropic" : "openai";
  return api.channels.create({
    name: source.sourceName,
    provider: source.provider,
    protocol,
    apiKey: `__cli_oauth__:${source.id}`,
    baseUrl:
      source.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
  });
}
