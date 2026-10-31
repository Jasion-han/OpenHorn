/**
 * Request rules for Anthropic Claude Code OAuth tokens (`sk-ant-oat…`).
 *
 * This is the single implementation of these rules. Every Anthropic caller —
 * the `AnthropicAdapter` (server chat / titles / summaries / probes, sidecar
 * chat mode) and the sidecar's self-managed Claude agent loop — goes through
 * the helpers below, so the rules can't drift between paths again.
 *
 * An OAuth token from a Claude CLI login differs from an API key in three ways:
 *
 * 1. Auth is `Authorization: Bearer <token>`, not `x-api-key`.
 * 2. The model id is sent without its date suffix (`claude-x-20250101` →
 *    `claude-x`).
 * 3. The token carries no API-billing quota. The server attributes a request
 *    to the user's Claude Code subscription only when `system[0]` is the
 *    billing marker below — exactly what the Claude CLI sends. Without it,
 *    Sonnet/Opus requests are refused with an opaque 429 `rate_limit_error`
 *    (Haiku still passes on its free tier).
 *
 *    The marker MUST be its own system text block. The server treats the block
 *    carrying it as billing metadata rather than prompt text; when the marker
 *    was `\n\n`-joined in front of the real prompt as one string, the model
 *    received no system prompt at all (it denied having one and ignored the
 *    agent / generative-UI instructions). The Claude CLI likewise sends the
 *    marker alone as `system[0]` and the actual prompt as `system[1]`.
 *
 * Verified 2026-09-10 against api.anthropic.com: the marker alone unlocks
 * Sonnet 4.6 and Opus 4.6 over Bearer auth; no beta header, metadata, or
 * `?beta=true` endpoint is required, and the build-hash suffix on the version
 * is optional. The sidecar injects the version of the locally installed CLI
 * (see `buildAnthropicBillingMarker`); environments without the CLI fall back
 * to `VERIFIED_CLAUDE_CODE_VERSION`, which was verified to be accepted.
 */

const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/** Last-resort `cc_version`, verified to be accepted by the API. */
export const VERIFIED_CLAUDE_CODE_VERSION = "2.1.267";

export type AnthropicTextBlock = { type: "text"; text: string };

export function isAnthropicOAuthToken(apiKey: string | null | undefined): boolean {
  return typeof apiKey === "string" && apiKey.startsWith(OAUTH_TOKEN_PREFIX);
}

/** Auth header for an Anthropic key: Bearer for OAuth tokens, `x-api-key` otherwise. */
export function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  return isAnthropicOAuthToken(apiKey)
    ? { Authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey };
}

/**
 * Model id to send: OAuth requests need the date suffix stripped; API-key
 * requests are unchanged. Takes the already-derived `isOAuth` flag so callers
 * that deliberately don't retain the key (the adapter) can use it too.
 */
export function normalizeAnthropicModelId(model: string, isOAuth: boolean): string {
  return isOAuth ? model.replace(/-\d{8}$/, "") : model;
}

/** The billing marker the Claude CLI sends as `system[0]`. */
export function buildAnthropicBillingMarker(
  ccVersion: string = VERIFIED_CLAUDE_CODE_VERSION,
): string {
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=sdk-cli;`;
}

/**
 * Builds the Messages API `system` param. With a billing marker the marker
 * becomes block 1 on its own and every other non-empty section is joined into
 * block 2 — merging them would make the API drop the whole prompt (see above).
 * Without a marker a single prompt block is sent (or none when empty).
 */
export function buildAnthropicSystem(
  billingMarker: string | null,
  sections: Array<string | null | undefined>,
): AnthropicTextBlock[] {
  const prompt = sections
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
  const blocks: AnthropicTextBlock[] = [];
  if (billingMarker) blocks.push({ type: "text", text: billingMarker });
  if (prompt) blocks.push({ type: "text", text: prompt });
  return blocks;
}
