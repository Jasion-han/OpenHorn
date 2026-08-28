# Local AI CLI Auth Mechanisms Research

Date: 2026-05-03

## 1. Codex CLI (OpenAI)

**Path:** `~/.codex/auth.json`  
**Format:** JSON, file permission `0600`  
**Auth type:** OAuth2 (ChatGPT account login), not a raw API key

Structure:
```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "<JWT>",
    "refresh_token": "<opaque>",
    "account_id": "<uuid>"
  },
  "last_refresh": "2026-04-25T07:16:40.151573Z"
}
```

- `auth_mode` is `"chatgpt"` for OAuth login, or API key mode when `OPENAI_API_KEY` is set.
- `access_token` is a short-lived JWT scoped to `https://api.openai.com/v1`. Contains plan type, org, user ID.
- `refresh_token` is used to rotate the access token automatically.
- `id_token` is an OIDC token with user email and account metadata.
- The access token can be used directly as a Bearer token against the OpenAI API.

**Reuse feasibility:** The `access_token` can be sent as `Authorization: Bearer <token>` to OpenAI endpoints. Scoped to the `api.connectors.read` and `api.connectors.invoke` scopes. Expiration is embedded in the JWT. The `refresh_token` can renew it via OpenAI's auth endpoint, but this requires the Codex client_id (`app_EMoamEEZ73f0CkXaXp7hrann`).

## 2. Claude Code CLI (Anthropic)

**Path:** macOS Keychain, service name `"Claude Code-credentials"`, account = `$USER`  
**Fallback config:** `~/.claude.json` (contains `oauthAccount` metadata, but NOT the token itself)  
**Format:** JSON blob stored as a Keychain generic password  
**Auth type:** OAuth2 (Anthropic account)

Key details:
- Claude Code stores credentials in the macOS Keychain using `security add-generic-password` / `find-generic-password`.
- The keychain entry service is `"Claude Code-credentials"` (or `"Claude Code-local-oauth-credentials"` for local dev builds).
- `~/.claude.json` stores non-secret account metadata: `accountUuid`, `emailAddress`, `billingType`, `organizationUuid`, etc.
- No API key file on disk; the OAuth token is exclusively in the Keychain.
- Reading requires: `security find-generic-password -a "$USER" -w -s "Claude Code-credentials"` which returns a JSON string.

**Reuse feasibility:** Reading the Keychain entry requires user permission (macOS will prompt). The token is an Anthropic OAuth token, not a standard API key. Third-party use would need to understand Anthropic's OAuth token format and refresh mechanism. Users can alternatively set `ANTHROPIC_API_KEY` env var to bypass OAuth entirely.

## 3. Gemini CLI (Google)

**Auth types** (configured in `~/.gemini/settings.json` under `security.auth.selectedType`):

| Type | Storage | Env Var |
|------|---------|---------|
| `gemini-api-key` | `GEMINI_API_KEY` env var or `.env` file | `GEMINI_API_KEY` |
| `login-with-google` | `~/.gemini/oauth_creds.json` (OAuth2 refresh/access tokens) | `GOOGLE_GENAI_USE_GCA=true` |
| `use-vertex-ai` | gcloud ADC (`~/.config/gcloud/application_default_credentials.json`) | `GOOGLE_GENAI_USE_VERTEXAI=true` |
| `cloud-shell` | Compute Engine metadata | N/A |

OAuth details (login-with-google mode):
- Client ID: `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com`
- Credentials file: `~/.gemini/oauth_creds.json`, permission `0600`, JSON format with `access_token`, `refresh_token`, `expiry_date`
- Google accounts tracked in `~/.gemini/google_accounts.json`
- Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`
- Optional encrypted storage via `FORCE_ENCRYPTED_FILE_STORAGE=true`

**Reuse feasibility:** API key mode is trivially reusable via the env var. OAuth tokens in `oauth_creds.json` could be read and used with the Google Auth Library, but refresh requires the embedded client ID/secret (which Google considers non-secret for installed apps).

## 4. Pi Coding Agent

Pi Coding Agent is **not a standalone open-source CLI tool** like the others. "Pi" from Inflection AI was a conversational assistant; Inflection pivoted to enterprise (Inflection for Enterprise). There is no public "Pi Coding Agent" CLI with local credential storage. The name may refer to:

- **Inflection AI's enterprise API** -- uses standard API keys, no local CLI auth mechanism.
- Community wrappers or plugins, not a first-party tool.

No local auth files or architecture to analyze. For multi-provider auth, the relevant reference is OpenHorn's own `genericAgentRuntime.ts` which already routes to different providers via API keys or OAuth tokens stored in the server config.

## 5. Security Considerations

| Concern | Detail |
|---------|--------|
| **File permissions** | Codex and Gemini use `0600`. Claude uses Keychain (OS-level access control). |
| **Token scope** | Codex tokens are scoped to the user's ChatGPT plan. Claude tokens are scoped to the Anthropic org. Gemini OAuth tokens have `cloud-platform` scope (broad). |
| **Reading others' creds** | Reading `~/.codex/auth.json` or `~/.gemini/oauth_creds.json` is trivial for any process running as the same user. Claude's Keychain storage is stronger -- macOS prompts for approval. |
| **Refresh tokens** | All three use refresh tokens. Stealing a refresh token grants persistent access until revoked. |
| **Programmatic access** | Codex: read JSON file. Claude: `security find-generic-password -w` (prompts user). Gemini: read JSON file or use `google-auth-library` `GoogleAuth` class which auto-discovers ADC. |
| **Safe reuse** | Reusing another tool's OAuth tokens is technically possible but ethically/legally questionable. The correct approach is to ask the user to authenticate via your own OAuth flow or accept their API key. Env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) are the standard, sanctioned mechanism for sharing credentials across tools. |

## Summary for OpenHorn

The safest multi-provider auth strategy:
1. **Prefer env vars** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) as the primary credential source.
2. **Detect existing CLI auth** as a convenience fallback: read `~/.codex/auth.json` for OpenAI OAuth tokens, check macOS Keychain for Claude tokens (will trigger user prompt), read `~/.gemini/oauth_creds.json` for Google OAuth.
3. **Never silently harvest** credentials. Always inform the user which credentials are being used and from where.
