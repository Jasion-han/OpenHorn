import { expect, test } from "bun:test";
import { evaluateAgentProbe } from "./channelAgentCheckService";

async function* gen(...events: Array<{ type?: string; content?: string }>) {
  for (const e of events) {
    yield e;
  }
}

test("evaluateAgentProbe: success when first text arrives", async () => {
  const result = await evaluateAgentProbe(
    gen({ type: "meta" }, { type: "text", content: "OK" }, { type: "done" }),
  );
  expect(result).toEqual({ success: true });
});

test("evaluateAgentProbe: fail when error arrives", async () => {
  const result = await evaluateAgentProbe(
    gen({ type: "meta" }, { type: "error", content: "boom" }),
  );
  expect(result).toEqual({ success: false, error: "boom" });
});

test("evaluateAgentProbe: fail when done without output", async () => {
  const result = await evaluateAgentProbe(gen({ type: "meta" }, { type: "done" }));
  expect(result.success).toBe(false);
});
