import { describe, expect, test } from "bun:test";
import { AnthropicAdapter, createAdapter } from "./adapters";
import {
  anthropicAuthHeaders,
  buildAnthropicBillingMarker,
  buildAnthropicSystem,
  isAnthropicOAuthToken,
  normalizeAnthropicModelId,
  VERIFIED_CLAUDE_CODE_VERSION,
} from "./anthropic-oauth";

// Fake credentials only — no real token ever appears in tests.
const OAUTH_KEY = "sk-ant-oat01-fake";
const API_KEY = "sk-ant-api03-fake";
const MARKER = "x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function captureFetch(response: () => Response) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return response();
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const jsonReply = () =>
  new Response(
    JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );

const sseReply = () =>
  new Response(
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );

const messages = [
  { role: "system" as const, content: "be brief" },
  { role: "user" as const, content: "hi" },
];

describe("anthropic-oauth helpers", () => {
  test("detects OAuth tokens by prefix", () => {
    expect(isAnthropicOAuthToken(OAUTH_KEY)).toBe(true);
    expect(isAnthropicOAuthToken(API_KEY)).toBe(false);
    expect(isAnthropicOAuthToken(undefined)).toBe(false);
  });

  test("auth header: Bearer for OAuth, x-api-key otherwise", () => {
    expect(anthropicAuthHeaders(OAUTH_KEY)).toEqual({ Authorization: `Bearer ${OAUTH_KEY}` });
    expect(anthropicAuthHeaders(API_KEY)).toEqual({ "x-api-key": API_KEY });
  });

  test("model id: date suffix stripped only for OAuth", () => {
    expect(normalizeAnthropicModelId("claude-sonnet-4-5-20250929", true)).toBe("claude-sonnet-4-5");
    expect(normalizeAnthropicModelId("claude-sonnet-4-6", true)).toBe("claude-sonnet-4-6");
    expect(normalizeAnthropicModelId("claude-sonnet-4-5-20250929", false)).toBe(
      "claude-sonnet-4-5-20250929",
    );
  });

  test("billing marker defaults to the verified CLI version", () => {
    expect(buildAnthropicBillingMarker()).toBe(
      `x-anthropic-billing-header: cc_version=${VERIFIED_CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`,
    );
    expect(buildAnthropicBillingMarker("9.9.9")).toBe(MARKER);
  });
});

describe("buildAnthropicSystem", () => {
  test("OAuth: billing marker is its own first block, prompt in the second", () => {
    const blocks = buildAnthropicSystem(MARKER, ["agent prompt", "react", "openui-lang Slider"]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: MARKER });
    expect(blocks[1]?.text).toBe("agent prompt\n\nreact\n\nopenui-lang Slider");
    expect(blocks[1]?.text.includes("x-anthropic-billing-header")).toBe(false);
  });

  test("non-OAuth: single prompt block without the marker", () => {
    const blocks = buildAnthropicSystem(null, ["agent prompt", "user prompt"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "agent prompt\n\nuser prompt" });
  });

  test("drops empty, null and undefined sections", () => {
    const blocks = buildAnthropicSystem(MARKER, ["a", null, "", "  ", undefined, "b"]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toBe("a\n\nb");
    expect(buildAnthropicSystem(null, [null, ""])).toHaveLength(0);
  });
});

describe("AnthropicAdapter with an OAuth token", () => {
  test("chat: Bearer auth, dated model stripped, marker + prompt as two system blocks", async () => {
    const cap = captureFetch(jsonReply);
    try {
      const adapter = new AnthropicAdapter(OAUTH_KEY, "https://example.com", {
        billingMarker: MARKER,
      });
      await adapter.chat({ model: "claude-sonnet-4-5-20250929", messages });
      const call = cap.calls[0];
      expect(call?.headers.Authorization).toBe(`Bearer ${OAUTH_KEY}`);
      expect(call?.headers["x-api-key"]).toBe(undefined);
      expect(call?.body.model).toBe("claude-sonnet-4-5");
      expect(call?.body.system).toEqual([
        { type: "text", text: MARKER },
        { type: "text", text: "be brief" },
      ]);
    } finally {
      cap.restore();
    }
  });

  test("chatStream via createAdapter: marker sent even with no system prompt", async () => {
    const cap = captureFetch(sseReply);
    try {
      const adapter = createAdapter("anthropic", OAUTH_KEY, "https://example.com", {
        anthropic: { billingMarker: MARKER },
      });
      const chunks: string[] = [];
      for await (const chunk of adapter.chatStream({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual(["ok"]);
      const call = cap.calls[0];
      expect(call?.headers.Authorization).toBe(`Bearer ${OAUTH_KEY}`);
      expect(call?.body.model).toBe("claude-sonnet-4-6");
      expect(call?.body.system).toEqual([{ type: "text", text: MARKER }]);
    } finally {
      cap.restore();
    }
  });

  test("chat: multiple system messages merge into one prompt block after the marker", async () => {
    const cap = captureFetch(jsonReply);
    try {
      const adapter = new AnthropicAdapter(OAUTH_KEY, "https://example.com", {
        billingMarker: MARKER,
      });
      await adapter.chat({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "first" },
          { role: "system", content: "   " },
          { role: "system", content: "second" },
          { role: "user", content: "hi" },
        ],
      });
      expect(cap.calls[0]?.body.system).toEqual([
        { type: "text", text: MARKER },
        { type: "text", text: "first\n\nsecond" },
      ]);
    } finally {
      cap.restore();
    }
  });

  test("runToolCallingTurn: default verified marker when none is injected", async () => {
    const cap = captureFetch(jsonReply);
    try {
      const adapter = new AnthropicAdapter(OAUTH_KEY, "https://example.com");
      await adapter.runToolCallingTurn({
        model: "claude-opus-4-1-20250805",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        tools: [],
      });
      const call = cap.calls[0];
      expect(call?.body.model).toBe("claude-opus-4-1");
      expect(call?.body.system).toEqual([
        { type: "text", text: buildAnthropicBillingMarker() },
        { type: "text", text: "sys" },
      ]);
    } finally {
      cap.restore();
    }
  });
});

describe("AnthropicAdapter with an API key (unchanged)", () => {
  test("chat: x-api-key, model untouched, plain-string system", async () => {
    const cap = captureFetch(jsonReply);
    try {
      const adapter = new AnthropicAdapter(API_KEY, "https://example.com", {
        billingMarker: MARKER,
      });
      await adapter.chat({ model: "claude-sonnet-4-5-20250929", messages });
      const call = cap.calls[0];
      expect(call?.headers["x-api-key"]).toBe(API_KEY);
      expect(call?.headers.Authorization).toBe(undefined);
      expect(call?.body.model).toBe("claude-sonnet-4-5-20250929");
      expect(call?.body.system).toBe("be brief");
    } finally {
      cap.restore();
    }
  });

  test("chatStream: no system field when there is no system prompt", async () => {
    const cap = captureFetch(sseReply);
    try {
      const adapter = new AnthropicAdapter(API_KEY, "https://example.com");
      for await (const _ of adapter.chatStream({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // drain
      }
      expect("system" in (cap.calls[0]?.body ?? {})).toBe(false);
    } finally {
      cap.restore();
    }
  });
});
