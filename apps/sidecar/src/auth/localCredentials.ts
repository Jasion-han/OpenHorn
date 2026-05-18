import { homedir } from "node:os";
import { join } from "node:path";

export type LocalCredential = {
  provider: "openai" | "anthropic" | "google";
  source: "codex_cli" | "claude_code" | "gemini_cli" | "env_var";
  type: "oauth_token" | "api_key";
  token: string;
  expiresAt?: Date;
  email?: string;
  directApiAccess: boolean;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function detectCodexCli(): Promise<LocalCredential | null> {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const file = Bun.file(authPath);
    if (!(await file.exists())) return null;
    const data = await file.json();
    if (data.auth_mode !== "chatgpt") return null;
    const accessToken = data.tokens?.access_token;
    if (!accessToken) return null;

    let expiresAt: Date | undefined;
    const payload = decodeJwtPayload(accessToken);
    if (payload && typeof payload.exp === "number") {
      expiresAt = new Date(payload.exp * 1000);
      if (expiresAt.getTime() < Date.now()) return null;
    }

    const email = typeof payload?.email === "string" ? payload.email : undefined;

    return {
      provider: "openai",
      source: "codex_cli",
      type: "oauth_token",
      token: accessToken,
      expiresAt,
      email,
      directApiAccess: false,
    };
  } catch {
    return null;
  }
}

async function detectClaudeCode(): Promise<LocalCredential | null> {
  try {
    const user = process.env.USER || process.env.USERNAME || "";
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const stdout = await new Response(proc.stdout).text();
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    let token: string;
    try {
      const parsed = JSON.parse(trimmed);
      token =
        parsed.claudeAiOauth?.accessToken ||
        parsed.oauth_token ||
        parsed.token ||
        parsed.access_token ||
        trimmed;
    } catch {
      token = trimmed;
    }

    if (!token) return null;

    return {
      provider: "anthropic",
      source: "claude_code",
      type: "oauth_token",
      token,
      directApiAccess: true,
    };
  } catch {
    return null;
  }
}

async function detectGeminiCli(): Promise<LocalCredential | null> {
  try {
    const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
    const file = Bun.file(credsPath);
    if (!(await file.exists())) return null;
    const data = await file.json();
    const accessToken = data.access_token;
    if (!accessToken) return null;

    let expiresAt: Date | undefined;
    if (data.expiry_date) {
      const ts = typeof data.expiry_date === "number" ? data.expiry_date : Number(data.expiry_date);
      if (Number.isFinite(ts)) {
        expiresAt = new Date(ts);
        if (expiresAt.getTime() < Date.now()) return null;
      }
    }

    return {
      provider: "google",
      source: "gemini_cli",
      type: "oauth_token",
      token: accessToken,
      expiresAt,
      directApiAccess: true,
    };
  } catch {
    return null;
  }
}

function detectEnvVar(
  envName: string,
  provider: LocalCredential["provider"],
): LocalCredential | null {
  const value = process.env[envName];
  if (!value || !value.trim()) return null;
  return {
    provider,
    source: "env_var",
    type: "api_key",
    token: value.trim(),
    directApiAccess: true,
  };
}

export async function detectAllCredentials(): Promise<LocalCredential[]> {
  const results: LocalCredential[] = [];

  const envOpenai = detectEnvVar("OPENAI_API_KEY", "openai");
  if (envOpenai) results.push(envOpenai);

  const envAnthropic = detectEnvVar("ANTHROPIC_API_KEY", "anthropic");
  if (envAnthropic) results.push(envAnthropic);

  const envGoogle = detectEnvVar("GEMINI_API_KEY", "google");
  if (envGoogle) results.push(envGoogle);

  const [codex, claude, gemini] = await Promise.all([
    detectCodexCli(),
    detectClaudeCode(),
    detectGeminiCli(),
  ]);

  if (codex) results.push(codex);
  if (claude) results.push(claude);
  if (gemini) results.push(gemini);

  return results;
}

export async function detectCredentialForProtocol(
  protocol: string,
): Promise<LocalCredential | null> {
  switch (protocol) {
    case "openai": {
      const env = detectEnvVar("OPENAI_API_KEY", "openai");
      if (env) return env;
      const codex = await detectCodexCli();
      if (codex?.directApiAccess) return codex;
      return null;
    }
    case "anthropic": {
      const env = detectEnvVar("ANTHROPIC_API_KEY", "anthropic");
      if (env) return env;
      return detectClaudeCode();
    }
    case "google": {
      const env = detectEnvVar("GEMINI_API_KEY", "google");
      if (env) return env;
      return detectGeminiCli();
    }
    default:
      return null;
  }
}
