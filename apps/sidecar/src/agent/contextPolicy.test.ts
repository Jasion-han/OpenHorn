import { expect, test } from "bun:test";
import { ChatContextBudgetError } from "shared/context-budget";
import { resolveContextPolicy } from "shared/context-policy";
import { validateMethodParams } from "../protocol";
import { appendAttachmentContext } from "./attachments";
import { assertAgentContext, boundAgentHistory } from "./contextPolicy";
import { buildModel } from "./direct";
import { codexChatContext, withConversationHistory } from "./runtimePrompt";

const largeHistory = [
  { role: "user" as const, content: `HISTORY-BEGIN${"h".repeat(90_000)}` },
  { role: "assistant" as const, content: "HISTORY-END" },
];

test("selected 1M Agent capacity keeps history beyond16K and current files beyond12K", () => {
  const input = { model: "gpt-6-astra", conversationHistory: largeHistory };
  const prompt = appendAttachmentContext("CURRENT", [
    {
      kind: "file",
      fileName: "large.txt",
      mediaType: "text/plain",
      text: `${"f".repeat(180_000)}FILE-END`,
    },
  ]);
  expect(boundAgentHistory(input, { prompt, systemPrompt: "instructions" })).toEqual(largeHistory);
  const serialized = withConversationHistory(prompt, largeHistory, input);
  expect(serialized).toContain("HISTORY-BEGIN");
  expect(serialized).toContain("HISTORY-END");
  expect(serialized.endsWith("FILE-END")).toBe(true);
  expect(codexChatContext([...largeHistory, { role: "user", content: prompt }]).prompt).toBe(
    serialized,
  );
});

test("final Agent budget counts complete current attachments and system instructions before history", () => {
  const input = { model: "unlisted", contextWindow: 8_192, conversationHistory: largeHistory };
  expect(() => boundAgentHistory(input, { prompt: "x".repeat(40_000) })).toThrow(
    ChatContextBudgetError,
  );
  expect(() =>
    boundAgentHistory(input, { prompt: "small", systemPrompt: "x".repeat(40_000) }),
  ).toThrow(ChatContextBudgetError);
  expect(() =>
    boundAgentHistory(input, { prompt: "small", tools: { description: "x".repeat(40_000) } }),
  ).toThrow(ChatContextBudgetError);
  expect(() => boundAgentHistory(input, { prompt: "small", imageCount: 5 })).toThrow(
    ChatContextBudgetError,
  );
});

test("Agent trimming keeps whole older turns and an explicit omission notice", () => {
  const current = "CURRENT-UNCHANGED";
  const history = [
    ...largeHistory,
    { role: "user" as const, content: "recent question" },
    { role: "assistant" as const, content: "recent answer" },
  ];
  expect(
    boundAgentHistory({ model: "unlisted", conversationHistory: history }, { prompt: current }),
  ).toEqual([{ role: "user", content: "[2 earlier messages omitted]" }, ...history.slice(2)]);
  expect(withConversationHistory(current, history, { model: "unlisted" })).toContain(current);
});

test("model descriptors use the same selected override and output allowance as Agent budgets", () => {
  const input = {
    model: "proxy-alias",
    contextWindow: 1_000_000,
    apiKey: "fixture",
    prompt: "q",
    cwd: "/tmp",
    abortController: new AbortController(),
    onEvent: () => {},
  };
  for (const protocol of ["openai", "google"]) {
    const model = buildModel({ ...input, protocol }, false);
    const policy = resolveContextPolicy({ ...input, protocol, mode: "agent" });
    expect(model.contextWindow).toBe(policy.contextWindow);
    expect(model.maxTokens).toBe(policy.maxOutputTokens);
  }
});

test("tool-transcript growth is rejected intact and image bytes are never counted as plain text", () => {
  const input = { model: "fixture", contextWindow: 8_192 };
  const messages = [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(40_000) }] }];
  const before = JSON.stringify(messages);
  expect(() => assertAgentContext(input, { systemPrompt: "system" }, messages)).toThrow(
    ChatContextBudgetError,
  );
  expect(JSON.stringify(messages)).toBe(before);
  expect(() =>
    assertAgentContext({ model: "gpt-6-astra" }, {}, [
      { role: "user", content: [{ type: "image", source: { data: "A".repeat(4_000_000) } }] },
    ]),
  ).not.toThrow();
});

test("both RPC schemas preserve configured model capacity and reject invalid values", () => {
  for (const method of ["chat.stream", "agent.run"]) {
    const base =
      method === "chat.stream"
        ? { model: "fixture", protocol: "openai", messages: [] }
        : { model: "fixture", prompt: "q" };
    for (const contextWindow of [null, 8_192, 1_000_000, 2_000_000]) {
      expect(
        (
          validateMethodParams(method, { ...base, contextWindow }) as {
            contextWindow: number | null;
          }
        ).contextWindow,
      ).toBe(contextWindow);
    }
    for (const contextWindow of [0, 8_191, 2_000_001, 10_000.5, "1000000", Number.NaN]) {
      expect(() => validateMethodParams(method, { ...base, contextWindow })).toThrow();
    }
  }
});
