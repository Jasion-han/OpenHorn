import { describe, expect, test } from "bun:test";
import type { Message } from "../types/chat";
import { messageHasOutput, selectStoppedRunOrphans } from "./stopCleanup";

type M = Pick<Message, "id" | "role" | "content" | "agentRun">;

const user = (id: string, content = "q"): M => ({ id, role: "user", content });
const reply = (id: string, content = "", agentRun?: Message["agentRun"]): M => ({
  id,
  role: "assistant",
  content,
  agentRun,
});
const run = (over: Partial<NonNullable<Message["agentRun"]>> = {}) => ({
  status: "completed" as const,
  summary: "",
  steps: [],
  ...over,
});

describe("messageHasOutput", () => {
  test("text, steps and errors all count as output", () => {
    expect(messageHasOutput({ content: "partial" })).toBe(true);
    expect(messageHasOutput({ content: "", agentRun: run({ error: "boom" }) })).toBe(true);
    expect(
      messageHasOutput({
        content: "",
        agentRun: run({ steps: [{ type: "tool_start" as const, content: "" }] }),
      }),
    ).toBe(true);
    expect(messageHasOutput({ content: "  ", agentRun: run() })).toBe(false);
  });
});

describe("selectStoppedRunOrphans", () => {
  test("deletes only the stopped run's empty reply, never other empty rows", () => {
    const history = [user("u-old"), reply("a-old-empty"), user("u-1"), reply("a-1")];
    expect(
      selectStoppedRunOrphans({ stoppedAssistantIds: ["a-1"], before: history, after: history }),
    ).toEqual(["a-1"]);
  });

  test("keeps a stopped reply that already has text, steps or an error", () => {
    const withText = [user("u-1"), reply("a-1", "half an answer")];
    expect(
      selectStoppedRunOrphans({ stoppedAssistantIds: ["a-1"], before: withText, after: withText }),
    ).toEqual([]);
    const withSteps = [
      user("u-1"),
      reply("a-1", "", run({ steps: [{ type: "tool_start" as const, content: "" }] })),
    ];
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["a-1"],
        before: withSteps,
        after: withSteps,
      }),
    ).toEqual([]);
    const withError = [user("u-1"), reply("a-1", "", run({ error: "x" }))];
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["a-1"],
        before: withError,
        after: withError,
      }),
    ).toEqual([]);
  });

  test("keeps the reply when the client already showed output, even if the server row is empty", () => {
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["a-1"],
        before: [user("u-1"), reply("a-1", "streamed so far")],
        after: [user("u-1"), reply("a-1")],
      }),
    ).toEqual([]);
  });

  test("keeps a regenerated reply whose server row still holds the previous answer", () => {
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["a-1"],
        before: [user("u-1"), reply("a-1", "", run({ status: "partial" }))],
        after: [user("u-1"), reply("a-1", "previous answer")],
      }),
    ).toEqual([]);
  });

  test("finds an optimistic reply's server row through its round", () => {
    // Edit-and-resend created the reply server-side; the stream was aborted
    // before `done` carried the real id, so the client only knows the temp id.
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["temp-assistant-edit-1"],
        before: [user("u-0"), reply("a-0", "ok"), user("u-1"), reply("temp-assistant-edit-1")],
        after: [user("u-0"), reply("a-0", "ok"), user("u-1"), reply("srv-a-1")],
      }),
    ).toEqual(["srv-a-1"]);
  });

  test("an optimistic round that never reached the server leaves nothing to delete", () => {
    const before = [user("u-0"), reply("a-0"), user("temp-1"), reply("temp-assistant-1")];
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: ["temp-assistant-1"],
        before,
        after: [user("u-0"), reply("a-0")],
      }),
    ).toEqual([]);
  });

  test("ignores missing / null ids and dedupes", () => {
    const list = [user("u-1"), reply("a-1")];
    expect(
      selectStoppedRunOrphans({
        stoppedAssistantIds: [null, undefined, "a-1", "a-1", "gone"],
        before: list,
        after: list,
      }),
    ).toEqual(["a-1"]);
  });

  test("never targets a user message", () => {
    const list = [user("u-1", "")];
    expect(
      selectStoppedRunOrphans({ stoppedAssistantIds: ["u-1"], before: list, after: list }),
    ).toEqual([]);
  });
});
