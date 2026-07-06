import { describe, expect, test } from "bun:test";
import type { Message } from "../types/chat";
import { findGroupIndexByMessageId, groupMessagesByRound } from "./messageGroups";

function msg(id: string, role: "user" | "assistant", mode: Message["mode"] = "chat"): Message {
  return {
    id,
    conversationId: "c1",
    role,
    content: `content-${id}`,
    mode,
    createdAt: new Date(0),
  };
}

describe("groupMessagesByRound", () => {
  test("packs a user + immediate assistant of the same mode into one round", () => {
    const groups = groupMessagesByRound([msg("u1", "user"), msg("a1", "assistant")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "u1:a1",
      user: { index: 0 },
      assistant: { index: 1 },
    });
  });

  test("keeps original flat indexes on the entries", () => {
    const groups = groupMessagesByRound([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ user: { index: 0 }, assistant: { index: 1 } });
    expect(groups[1]).toMatchObject({ key: "u2:a2", user: { index: 2 }, assistant: { index: 3 } });
  });

  test("does not pair when modes differ", () => {
    const groups = groupMessagesByRound([
      msg("u1", "user", "agent"),
      msg("a1", "assistant", "chat"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "u1", user: { index: 0 } });
    expect(groups[1]).toMatchObject({ key: "a1", assistant: { index: 1 } });
  });

  test("a lone user message becomes its own group keyed by its id", () => {
    const groups = groupMessagesByRound([msg("u1", "user")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "u1", user: { index: 0 } });
  });

  test("a lone assistant message becomes its own group keyed by its id", () => {
    const groups = groupMessagesByRound([msg("a1", "assistant")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "a1", assistant: { index: 0 } });
  });

  test("group keys are stable across content changes (streaming) for getItemKey", () => {
    const before = groupMessagesByRound([msg("u1", "user"), msg("a1", "assistant")]);
    const streamed = msg("a1", "assistant");
    streamed.content = "streamed tokens...";
    const after = groupMessagesByRound([msg("u1", "user"), streamed]);
    expect(after[0]?.key).toBe(before[0]?.key);
  });
});

describe("findGroupIndexByMessageId", () => {
  const groups = groupMessagesByRound([
    msg("u1", "user"),
    msg("a1", "assistant"),
    msg("u2", "user"),
    msg("a2", "assistant"),
    msg("u3", "user"),
  ]);

  test("finds a group by its user message id", () => {
    expect(findGroupIndexByMessageId(groups, "u2")).toBe(1);
  });

  test("finds a group by its assistant message id", () => {
    expect(findGroupIndexByMessageId(groups, "a1")).toBe(0);
  });

  test("finds a lone user group", () => {
    expect(findGroupIndexByMessageId(groups, "u3")).toBe(2);
  });

  test("returns -1 when the message id is absent", () => {
    expect(findGroupIndexByMessageId(groups, "missing")).toBe(-1);
  });
});
