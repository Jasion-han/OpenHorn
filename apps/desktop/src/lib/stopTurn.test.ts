import { describe, expect, test } from "bun:test";
import type { ApiAgentRun, Message } from "../types/chat";
import {
  isPersistedMessageId,
  replyHasOutput,
  resolvePlainReplyEndState,
  resolveRunEndState,
  resolveSidecarSyncIds,
  resolveStoppedAgentReply,
  stopAgentRun,
} from "./stopTurn";

const run = (over: Partial<ApiAgentRun> = {}): ApiAgentRun => ({
  status: "partial",
  summary: "Working",
  steps: [],
  ...over,
});

const previous: Message = {
  id: "a-1",
  conversationId: "c-1",
  role: "assistant",
  content: "previous answer",
  mode: "agent",
  agentRun: {
    status: "completed",
    summary: "",
    steps: [{ type: "text", content: "previous answer" }],
  },
  createdAt: new Date("2026-10-31T10:00:00.000Z"),
};

describe("stopAgentRun", () => {
  test("an in-progress run becomes cancelled and keeps every step", () => {
    const steps: ApiAgentRun["steps"] = [
      { type: "tool_start", toolName: "Read" },
      { type: "text", content: "half an answer" },
    ];
    for (const status of ["partial", "running", "awaiting_approval"] as const) {
      expect(stopAgentRun(run({ status, steps }))).toMatchObject({ status: "cancelled", steps });
    }
  });

  test("a run that already finished keeps its outcome", () => {
    const done = run({ status: "completed", steps: [{ type: "text", content: "x" }] });
    expect(stopAgentRun(done)).toBe(done);
    const failed = run({ status: "failed", error: "boom" });
    expect(stopAgentRun(failed)).toBe(failed);
  });

  test("a reply stopped before its first event gets an empty cancelled run", () => {
    expect(stopAgentRun(undefined)).toEqual({ status: "cancelled", summary: "", steps: [] });
  });
});

describe("resolveStoppedAgentReply", () => {
  test("partial output is persisted as the reply, content derived from text steps", () => {
    const outcome = resolveStoppedAgentReply({
      current: {
        content: "stale",
        agentRun: run({
          steps: [
            { type: "thinking", content: "hmm" },
            { type: "text", content: "first half " },
          ],
        }),
      },
    });
    expect(outcome.kind).toBe("persist");
    if (outcome.kind !== "persist") return;
    expect(outcome.assistantContent).toBe("first half");
    expect(outcome.agentRun.status).toBe("cancelled");
    expect(outcome.agentRun.steps).toHaveLength(2);
  });

  test("nothing generated on a new send / edit: persisted as an empty cancelled reply", () => {
    const outcome = resolveStoppedAgentReply({ current: { content: "", agentRun: run() } });
    expect(outcome).toEqual({
      kind: "persist",
      assistantContent: "",
      agentRun: { status: "cancelled", summary: "", steps: [] },
    });
  });

  test("regenerate stopped before any output restores the previous reply", () => {
    expect(
      resolveStoppedAgentReply({
        current: { content: "", agentRun: run() },
        previousReply: previous,
      }),
    ).toEqual({ kind: "restore", reply: previous });
  });

  test("regenerate stopped after producing output replaces the previous reply", () => {
    const outcome = resolveStoppedAgentReply({
      current: { content: "", agentRun: run({ steps: [{ type: "text", content: "new" }] }) },
      previousReply: previous,
    });
    expect(outcome).toMatchObject({ kind: "persist", assistantContent: "new" });
  });

  test("a tool call alone counts as output", () => {
    const outcome = resolveStoppedAgentReply({
      current: {
        content: "",
        agentRun: run({ steps: [{ type: "tool_start", toolName: "Bash" }] }),
      },
      previousReply: previous,
    });
    expect(outcome.kind).toBe("persist");
  });
});

describe("resolveSidecarSyncIds", () => {
  test("a fresh send inserts a new pair", () => {
    expect(resolveSidecarSyncIds({})).toEqual({});
  });

  test("regenerate / edit with a reply updates the round in place", () => {
    expect(
      resolveSidecarSyncIds({ existingUserMessageId: "u-1", existingAssistantMessageId: "a-1" }),
    ).toEqual({ userMessageId: "u-1", assistantMessageId: "a-1" });
  });

  test("edit of a user message without a persisted reply reuses only the user row", () => {
    expect(
      resolveSidecarSyncIds({
        existingUserMessageId: "u-1",
        existingAssistantMessageId: "temp-assistant-edit-1",
      }),
    ).toEqual({ userMessageId: "u-1" });
  });

  test("optimistic ids never reach the server", () => {
    expect(
      resolveSidecarSyncIds({
        existingUserMessageId: "draft-user-1",
        existingAssistantMessageId: "a-1",
      }),
    ).toEqual({});
    expect(isPersistedMessageId("temp-1")).toBe(false);
    expect(isPersistedMessageId(undefined)).toBe(false);
    expect(isPersistedMessageId("srv-1")).toBe(true);
  });
});

describe("resolveRunEndState", () => {
  test("a stopped reply with output closes with the stopped line", () => {
    expect(
      resolveRunEndState(run({ status: "cancelled", steps: [{ type: "text", content: "x" }] })),
    ).toBe("stopped");
  });

  test("a reply stopped before any output reads as cancelled", () => {
    expect(resolveRunEndState(run({ status: "cancelled" }))).toBe("cancelled");
  });

  test("a finished run without any output says there is no reply", () => {
    expect(resolveRunEndState(run({ status: "completed" }))).toBe("noReply");
  });

  test("running, failed-with-error and ordinary finished runs add no line", () => {
    expect(resolveRunEndState(run())).toBe("none");
    expect(resolveRunEndState(run({ status: "failed", error: "boom" }))).toBe("none");
    expect(
      resolveRunEndState(run({ status: "completed", steps: [{ type: "text", content: "x" }] })),
    ).toBe("none");
    expect(resolveRunEndState(undefined)).toBe("none");
  });
});

describe("replyHasOutput", () => {
  test("text, steps and errors count; whitespace does not", () => {
    expect(replyHasOutput({ content: "partial" })).toBe(true);
    expect(replyHasOutput({ content: "", agentRun: run({ error: "x" }) })).toBe(true);
    expect(
      replyHasOutput({ content: "", agentRun: run({ steps: [{ type: "tool_start" }] }) }),
    ).toBe(true);
    expect(replyHasOutput({ content: "  " })).toBe(false);
  });
});

describe("resolvePlainReplyEndState", () => {
  test("a stopped reply without a run reads as stopped (with text) or cancelled (without)", () => {
    expect(resolvePlainReplyEndState({ content: "half", finishReason: "stopped" })).toBe("stopped");
    expect(resolvePlainReplyEndState({ content: " ", finishReason: "stopped" })).toBe("cancelled");
  });

  test("an unstopped reply closes only when it holds nothing", () => {
    expect(resolvePlainReplyEndState({ content: "answer" })).toBe("none");
    expect(resolvePlainReplyEndState({ content: "" })).toBe("noReply");
  });
});
