import { describe, expect, test } from "bun:test";
import { sanitizeChildEnv } from "./childEnv";

describe("sanitizeChildEnv", () => {
  test("omits the sidecar handshake token and service secrets", () => {
    const sanitized = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      OPENHORN_HANDSHAKE_TOKEN: "secret-token",
      CLAUDE_CODE_SSE_PORT: "1234",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      DEEPSEEK_API_KEY: "sk-ds",
      GOOGLE_API_KEY: "g-key",
      GEMINI_API_KEY: "gm-key",
      TAVILY_API_KEY: "tv-key",
      JWT_SECRET: "jwt",
      ENCRYPTION_KEY: "enc",
      DATABASE_URL: "file:./data.db",
    });

    // Preserves unrelated keys needed for npx/uvx and child auth config.
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/user");

    // Strips every secret / handshake key.
    for (const key of [
      "OPENHORN_HANDSHAKE_TOKEN",
      "CLAUDE_CODE_SSE_PORT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "TAVILY_API_KEY",
      "JWT_SECRET",
      "ENCRYPTION_KEY",
      "DATABASE_URL",
    ]) {
      expect(Object.hasOwn(sanitized, key)).toBe(false);
    }
  });

  test("does not mutate the input object", () => {
    const input = { PATH: "/usr/bin", JWT_SECRET: "jwt" };
    sanitizeChildEnv(input);
    expect(input.JWT_SECRET).toBe("jwt");
  });
});

// Every runtime that hands a model-controlled command to a child process must
// route its env through sanitizeChildEnv. Unit-testing the helper alone does
// not prove it is actually *called* — that gap is how direct.ts and claude.ts
// leaked OPENHORN_HANDSHAKE_TOKEN while childEnv.test.ts stayed green.
describe("child env hygiene is wired into every model-facing spawn path", () => {
  const MODEL_FACING_RUNTIMES = [
    "src/agent/direct.ts",
    "src/agent/claude.ts",
    "src/agent/codex.ts",
    "src/agent/chatCodex.ts",
    "src/agent/mcp-tools.ts",
  ];

  for (const relPath of MODEL_FACING_RUNTIMES) {
    test(`${relPath} uses sanitizeChildEnv`, async () => {
      const source = await Bun.file(new URL(`../../${relPath}`, import.meta.url)).text();
      expect(source.includes("sanitizeChildEnv")).toBe(true);
    });
  }
});
