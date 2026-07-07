/**
 * Env hygiene for spawned child processes (codex CLI, stdio MCP servers).
 *
 * These children run arbitrary user-configured code with a full shell, so they
 * must NOT inherit the sidecar's handshake token or unrelated service
 * credentials — a `printenv` inside a prompt-injected child would otherwise leak
 * them. The strip list mirrors the env hygiene originally in codex.ts /
 * claude.ts; keeping it in one place ensures the codex and MCP paths stay in
 * sync. Children that legitimately need auth use their own config (e.g. codex's
 * `~/.codex`, keyed off HOME) or an explicitly-provided `config.env`.
 */

function isSensitiveEnvKey(key: string): boolean {
  return (
    key.startsWith("OPENHORN") ||
    key.startsWith("CLAUDE") ||
    key.startsWith("CODEX_COMPANION") ||
    key.startsWith("TRELLIS_") ||
    key === "AI_AGENT" ||
    key === "ANTHROPIC_API_KEY" ||
    key === "ANTHROPIC_BASE_URL" ||
    key === "OPENAI_API_KEY" ||
    key === "DEEPSEEK_API_KEY" ||
    key === "GOOGLE_API_KEY" ||
    key === "GEMINI_API_KEY" ||
    key === "TAVILY_API_KEY" ||
    key === "JWT_SECRET" ||
    key === "ENCRYPTION_KEY" ||
    key === "DATABASE_URL"
  );
}

/**
 * Returns a copy of `env` with the sidecar's secrets/handshake token removed.
 * Non-mutating; unrelated keys (PATH, HOME, etc.) are preserved so tools like
 * npx/uvx and the codex CLI still work.
 */
export function sanitizeChildEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (isSensitiveEnvKey(key)) delete out[key];
  }
  return out;
}
