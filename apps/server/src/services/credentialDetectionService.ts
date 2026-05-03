import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CredentialProvider,
  CredentialSource,
  CredentialSourceType,
  CredentialStatus,
} from "shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsonFile(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function makeSource(
  id: string,
  provider: CredentialProvider,
  sourceType: CredentialSourceType,
  sourceName: string,
  status: CredentialStatus,
  error?: string,
): CredentialSource {
  return {
    id,
    provider,
    sourceType,
    sourceName,
    status,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Environment variable detectors
// ---------------------------------------------------------------------------

function detectEnvVar(envName: string, provider: CredentialProvider): CredentialSource | null {
  const value = process.env[envName];
  if (typeof value !== "string" || !value.trim()) return null;
  return makeSource(
    `env-${envName.toLowerCase().replace(/_/g, "-")}`,
    provider,
    "env_var",
    envName,
    "available",
  );
}

// ---------------------------------------------------------------------------
// Codex CLI (OpenAI OAuth)
// ---------------------------------------------------------------------------

function detectCodexCli(): CredentialSource | null {
  const filePath = join(homedir(), ".codex", "auth.json");
  const data = readJsonFile(filePath);
  if (!isRecord(data)) return null;

  if (data.auth_mode !== "chatgpt") return null;

  const tokens = isRecord(data.tokens) ? data.tokens : null;
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token.trim()) {
    return makeSource(
      "cli-codex",
      "openai",
      "cli_oauth",
      "Codex CLI",
      "error",
      "No access_token found in ~/.codex/auth.json",
    );
  }

  return makeSource("cli-codex", "openai", "cli_oauth", "Codex CLI", "available");
}

function getCodexCliCredential(): string | null {
  const filePath = join(homedir(), ".codex", "auth.json");
  const data = readJsonFile(filePath);
  if (!isRecord(data)) return null;
  const tokens = isRecord(data.tokens) ? data.tokens : null;
  if (!tokens || typeof tokens.access_token !== "string") return null;
  return tokens.access_token.trim() || null;
}

// ---------------------------------------------------------------------------
// Claude Code (macOS Keychain)
// ---------------------------------------------------------------------------

function detectClaudeCode(): CredentialSource | null {
  if (process.platform !== "darwin") return null;

  try {
    const user = process.env.USER || "";
    if (!user) return null;

    // Check existence without reading the value (-w) to avoid triggering
    // the macOS permission dialog during detection.
    execSync(
      `security find-generic-password -a "${user}" -s "Claude Code-credentials" 2>/dev/null`,
      { stdio: "pipe", timeout: 5000 },
    );
    return makeSource(
      "cli-claude-code",
      "anthropic",
      "cli_oauth",
      "Claude Code Keychain",
      "available",
    );
  } catch {
    return null;
  }
}

function getClaudeCodeCredential(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const user = process.env.USER || "";
    if (!user) return null;
    const raw = execSync(
      `security find-generic-password -a "${user}" -w -s "Claude Code-credentials"`,
      { stdio: "pipe", timeout: 5000 },
    )
      .toString()
      .trim();
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
        if (typeof oauth.accessToken === "string") return oauth.accessToken;
        if (typeof oauth.access_token === "string") return oauth.access_token;
      }
    } catch {
      // Not JSON -- the raw value itself is the token.
    }
    return raw;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini CLI (Google OAuth)
// ---------------------------------------------------------------------------

function detectGeminiCli(): CredentialSource | null {
  const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
  const data = readJsonFile(credsPath);
  if (!isRecord(data)) return null;

  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    return makeSource(
      "cli-gemini",
      "google",
      "cli_oauth",
      "Gemini CLI",
      "error",
      "No access_token found in ~/.gemini/oauth_creds.json",
    );
  }

  // Check if expired
  if (typeof data.expiry_date === "number" && data.expiry_date < Date.now()) {
    return makeSource("cli-gemini", "google", "cli_oauth", "Gemini CLI", "expired");
  }

  return makeSource("cli-gemini", "google", "cli_oauth", "Gemini CLI", "available");
}

function getGeminiCliCredential(): string | null {
  const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
  const data = readJsonFile(credsPath);
  if (!isRecord(data) || typeof data.access_token !== "string") {
    return null;
  }
  return data.access_token.trim() || null;
}

// ---------------------------------------------------------------------------
// Priority chains (first match wins per provider)
// ---------------------------------------------------------------------------

const DETECTION_CHAINS: Array<{
  provider: CredentialProvider;
  detectors: (() => CredentialSource | null)[];
}> = [
  {
    provider: "anthropic",
    detectors: [
      () => detectEnvVar("ANTHROPIC_OAUTH_TOKEN", "anthropic"),
      () => detectEnvVar("ANTHROPIC_API_KEY", "anthropic"),
      () => detectClaudeCode(),
    ],
  },
  {
    provider: "openai",
    detectors: [() => detectEnvVar("OPENAI_API_KEY", "openai"), () => detectCodexCli()],
  },
  {
    provider: "google",
    detectors: [() => detectEnvVar("GEMINI_API_KEY", "google"), () => detectGeminiCli()],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan the environment for all available credential sources.
 * Returns a flat list; each provider may have zero or more sources.
 * Priority is encoded by array order -- the first source per provider
 * is the preferred one.
 */
export async function detectCredentialSources(): Promise<CredentialSource[]> {
  const sources: CredentialSource[] = [];

  for (const chain of DETECTION_CHAINS) {
    for (const detect of chain.detectors) {
      const source = detect();
      if (source) {
        sources.push(source);
      }
    }
  }

  return sources;
}

/**
 * Retrieve the actual credential (API key / OAuth token) for a source id.
 */
export async function getCredential(
  sourceId: string,
): Promise<{ apiKey: string } | { error: string }> {
  // Environment variable sources
  const envMapping: Record<string, string | undefined> = {
    "env-anthropic-oauth-token": process.env.ANTHROPIC_OAUTH_TOKEN,
    "env-anthropic-api-key": process.env.ANTHROPIC_API_KEY,
    "env-openai-api-key": process.env.OPENAI_API_KEY,
    "env-gemini-api-key": process.env.GEMINI_API_KEY,
  };

  if (sourceId in envMapping) {
    const value = envMapping[sourceId];
    if (typeof value === "string" && value.trim()) {
      return { apiKey: value.trim() };
    }
    return { error: "Environment variable is not set or empty" };
  }

  // CLI OAuth sources
  if (sourceId === "cli-codex") {
    const token = getCodexCliCredential();
    if (token) return { apiKey: token };
    return {
      error: "Failed to read Codex CLI credential from ~/.codex/auth.json",
    };
  }

  if (sourceId === "cli-claude-code") {
    const token = getClaudeCodeCredential();
    if (token) return { apiKey: token };
    return {
      error: "Failed to read Claude Code credential from macOS Keychain",
    };
  }

  if (sourceId === "cli-gemini") {
    const token = getGeminiCliCredential();
    if (token) return { apiKey: token };
    return {
      error: "Failed to read Gemini CLI credential from ~/.gemini/oauth_creds.json",
    };
  }

  return { error: `Unknown credential source: ${sourceId}` };
}

/**
 * Resolve a CLI OAuth source id to a usable API key/token.
 * Used by channelService when a channel's stored apiKey is `__cli_oauth__:<sourceId>`.
 */
export async function resolveCliOAuthApiKey(sourceId: string): Promise<string | null> {
  const result = await getCredential(sourceId);
  if ("apiKey" in result) return result.apiKey;
  return null;
}
