import { expect, test } from "bun:test";
import { createAdapter, supportsToolCalling } from "./adapters";

for (const protocol of ["openai", "anthropic", "google"]) {
  test(`${protocol} budgeted tool requests do not retry transient HTTP failures`, async () => {
    const oldFetch = globalThis.fetch;
    let calls = 0,
      failed = false;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(
        { error: { message: "Synthetic temporarily unavailable" } },
        { status: 503 },
      );
    }) as unknown as typeof fetch;
    try {
      const adapter = createAdapter(protocol, "synthetic-research-key");
      if (!supportsToolCalling(adapter)) throw new Error("Expected tool adapter");
      try {
        await adapter.runToolCallingTurn({
          model: "synthetic",
          messages: [{ role: "user", content: "Research" }],
          tools: [],
          noRetry: true,
          requestTimeoutMs: 1000,
        });
      } catch {
        failed = true;
      }
      expect(calls).toBe(1);
      expect(failed).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test(`${protocol} final research synthesis omits empty tool declarations and honors the output cap`, async () => {
    const oldFetch = globalThis.fetch;
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json(
        protocol === "openai"
          ? { choices: [{ message: { content: "Research report" }, finish_reason: "stop" }] }
          : protocol === "anthropic"
            ? { content: [{ type: "text", text: "Research report" }], stop_reason: "end_turn" }
            : {
                candidates: [
                  { content: { parts: [{ text: "Research report" }] }, finishReason: "STOP" },
                ],
              },
      );
    }) as unknown as typeof fetch;
    try {
      const adapter = createAdapter(protocol, "synthetic-research-key");
      if (!supportsToolCalling(adapter)) throw new Error("Expected tool adapter");
      const result = await adapter.runToolCallingTurn({
        model: "synthetic",
        messages: [{ role: "user", content: "Research" }],
        tools: [],
        noRetry: true,
        maxTokens: 4000,
      });
      expect(result.text).toBe("Research report");
      expect(payload.tools).toBeUndefined();
      expect(payload.tool_choice).toBeUndefined();
      expect(payload.toolConfig).toBeUndefined();
      expect(protocol === "google" ? payload.generationConfig : payload.max_tokens).toEqual(
        protocol === "google" ? { maxOutputTokens: 4000 } : 4000,
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
}
