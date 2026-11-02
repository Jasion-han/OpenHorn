import { expect, mock, test } from "bun:test";
import * as attachmentNamespace from "./attachmentService";

const realAttachmentService = { ...attachmentNamespace };

import { buildChatMessages } from "./messageService";

test("a current request exceeding the Chat budget is explicitly rejected", async () => {
  await expect(
    buildChatMessages(
      "context-budget-no-provider",
      [{ role: "user", content: "x".repeat(113_000) }],
      "System instructions",
    ),
  ).rejects.toThrow("context budget");
});

test("the real Chat builder keeps a current question after omitting an oversized answer", async () => {
  const result = await buildChatMessages("context-budget-no-provider", [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "x".repeat(113_000) },
    { role: "user", content: "current request" },
    { role: "assistant", content: "" },
  ]);
  expect(result).toEqual([
    { role: "system", content: "[2 earlier messages omitted]" },
    { role: "user", content: "current request" },
  ]);
});

test("a previous unanswered user message cannot consume the current question's reservation", async () => {
  const result = await buildChatMessages("context-budget-no-provider", [
    { role: "user", content: "x".repeat(113_000) },
    { role: "user", content: "current request" },
  ]);
  expect(result.at(-1)).toEqual({ role: "user", content: "current request" });
  expect(result[0]?.content).toBe("[1 earlier messages omitted]");
});

test("coarse history limits preserve a system section and the latest user", async () => {
  const result = await buildChatMessages("context-budget-no-provider", [
    { role: "system", content: "stored system" },
    ...Array.from({ length: 240 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history ${index}`,
    })),
    { role: "user", content: "current request" },
  ]);
  expect(String(result[0]?.content).includes("stored system")).toBe(true);
  expect(String(result[0]?.content).includes("earlier messages omitted")).toBe(true);
  expect(result.at(-1)).toEqual({ role: "user", content: "current request" });
});

test("a coarse cap cannot remove a current user before many empty assistant placeholders", async () => {
  const result = await buildChatMessages("context-budget-no-provider", [
    { role: "system", content: "stored system" },
    { role: "user", content: "current request" },
    ...Array.from({ length: 240 }, () => ({ role: "assistant", content: "" })),
  ]);
  expect(result).toEqual([
    { role: "system", content: "stored system" },
    { role: "user", content: "current request" },
  ]);
});

test("large history stops attachment expansion after the first non-fitting whole turn", async () => {
  const fetched: string[] = [];
  mock.module("./attachmentService", () => ({
    ...realAttachmentService,
    buildAttachmentPayloadFromIds: async (ids: string[]) => {
      fetched.push(...ids);
      return {
        textContext: ids[0] === "newest" ? "x".repeat(3_500_000) : "CURRENT-ATTACHMENT",
        images: [],
        files: [],
      };
    },
  }));
  try {
    const history = Array.from({ length: 5000 }, (_, index) => [
      {
        role: "user",
        content: `question ${index}`,
        attachments: JSON.stringify([index === 4999 ? "newest" : `old-${index}`]),
      },
      { role: "assistant", content: `answer ${index}` },
    ]).flat();
    const result = await buildChatMessages(
      "context-budget-no-provider",
      [
        { role: "system", content: "STORED-SYSTEM" },
        ...history,
        { role: "user", content: "CURRENT-QUESTION", attachments: JSON.stringify(["current"]) },
      ],
      "GLOBAL-SYSTEM",
      undefined,
      { maxTokens: 922_000, maxMessages: 10_000 },
    );
    expect(fetched).toEqual(["current", "newest"]);
    expect(String(result[0]?.content).includes("GLOBAL-SYSTEM")).toBe(true);
    expect(String(result[0]?.content).includes("STORED-SYSTEM")).toBe(true);
    expect(String(result[0]?.content).includes("[10000 earlier messages omitted]")).toBe(true);
    expect(String(result.at(-1)?.content).includes("CURRENT-QUESTION")).toBe(true);
    expect(String(result.at(-1)?.content).includes("CURRENT-ATTACHMENT")).toBe(true);
  } finally {
    mock.module("./attachmentService", () => realAttachmentService);
  }
});
