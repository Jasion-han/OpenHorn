import { expect, mock, test } from "bun:test";
import { probeAnthropicModel } from "./anthropicProbe";

test("probeAnthropicModel uses the provided model id in the request body", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(raw) as { model?: string };
    expect(parsed.model).toBe("anthropic/claude-sonnet-4.6");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  try {
    const result = await probeAnthropicModel(
      "https://relay.example.com",
      "test-key",
      "anthropic/claude-sonnet-4.6",
    );
    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});

test("probeAnthropicModel treats model-specific 400 responses as failures", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "model_not_found: anthropic/claude-sonnet-4.6",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
  ) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  try {
    const result = await probeAnthropicModel(
      "https://relay.example.com",
      "test-key",
      "anthropic/claude-sonnet-4.6",
    );
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.reason).toBe("model");
      expect(result.error).toContain("model_not_found");
    }
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
