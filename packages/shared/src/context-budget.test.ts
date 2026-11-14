import { expect, test } from "bun:test";
import {
  boundChatContext,
  CHAT_MAX_CONTEXT_MESSAGES,
  ChatContextBudgetError,
  estimateContextMessageTokens,
} from "./context-budget";

type Message = { role: "system" | "user" | "assistant"; content: string };

test("provider continuation data consumes budget and is omitted with its whole historical turn", () => {
  const state = { provider: "deepseek", serverToolCalls: [{ signature: "s".repeat(5000) }] };
  const answer = { role: "assistant" as const, content: "short", providerState: state };
  expect(estimateContextMessageTokens(answer) > 1000).toBe(true);
  const bounded = boundChatContext(
    [{ role: "user" as const, content: "old" }, answer, { role: "user" as const, content: "new" }],
    { maxTokens: 100 },
  );
  expect(bounded).toEqual([
    { role: "system", content: "[2 earlier messages omitted]" },
    { role: "user", content: "new" },
  ]);
});

test("a current request is never silently removed to satisfy the budget", () => {
  expect(() =>
    boundChatContext([
      { role: "system", content: "instructions" },
      { role: "user", content: "x".repeat(113_000) },
    ]),
  ).toThrow(ChatContextBudgetError);
});

test("all system sections consume budget and keep their full contents", () => {
  const system: Message = { role: "system", content: "global plus UI schema\n".repeat(2_000) };
  const current: Message = { role: "user", content: "x".repeat(70_000) };
  expect(() => boundChatContext([system, current])).toThrow(ChatContextBudgetError);
  expect(boundChatContext([system, { role: "user", content: "q" }])[0]).toEqual(system);
});

test("an oversized historical answer is omitted with its question, leaving the current request", () => {
  expect(
    boundChatContext([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "x".repeat(113_000) },
      { role: "user", content: "current request" },
    ]),
  ).toEqual([
    { role: "system", content: "[2 earlier messages omitted]" },
    { role: "user", content: "current request" },
  ]);
});

test("history keeps complete question-answer groups in order and includes notice cost", () => {
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "x".repeat(200) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "recent question" },
    { role: "assistant", content: "recent answer" },
    { role: "user", content: "current request" },
  ];
  const bounded = boundChatContext(messages, { maxTokens: 80 });
  expect(bounded).toEqual([
    messages[0],
    { role: "system", content: "[2 earlier messages omitted]" },
    ...messages.slice(3),
  ]);
  expect(
    bounded.reduce((sum, message) => sum + estimateContextMessageTokens(message), 0) <= 80,
  ).toBe(true);
  expect(messages).toHaveLength(6);
});

test("the message cap preserves every system section and the current request", () => {
  const messages: Message[] = [
    { role: "system", content: "first system" },
    ...Array.from(
      { length: 240 },
      (_, index): Message => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history ${index}`,
      }),
    ),
    { role: "system", content: "late UI schema" },
    { role: "user", content: "current" },
  ];
  const bounded = boundChatContext(messages);
  expect(bounded.length <= CHAT_MAX_CONTEXT_MESSAGES).toBe(true);
  expect(bounded.slice(0, 2)).toEqual([messages[0], messages.at(-2)]);
  expect(bounded.at(-1)).toEqual(messages.at(-1));
  expect(bounded[2]?.content).toBe("[44 earlier messages omitted]");
});

test("expanded multipart text and images consume the same final budget", () => {
  expect(() =>
    boundChatContext([
      {
        role: "user",
        content: [
          { type: "text", text: "question" },
          { type: "text", text: "attachment contents".repeat(7_000) },
        ],
      },
    ]),
  ).toThrow(ChatContextBudgetError);
  expect(
    estimateContextMessageTokens({
      role: "user",
      content: [{ type: "image", mediaType: "image/png", dataBase64: "AAAA" }],
    }) > 10,
  ).toBe(true);
});

test("full fitting histories need no omission reserve and remain unchanged", () => {
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "user", content: "c" },
  ];
  expect(boundChatContext(messages, { maxTokens: 33 })).toEqual(messages);
});

test("if even an omission notice cannot fit, reject instead of silently hiding history", () => {
  expect(() =>
    boundChatContext(
      [
        { role: "user", content: "oversized old turn" },
        { role: "user", content: "current" },
      ],
      { maxTokens: 15 },
    ),
  ).toThrow(ChatContextBudgetError);
});
